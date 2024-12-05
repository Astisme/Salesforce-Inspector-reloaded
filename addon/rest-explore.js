/* global React ReactDOM */
import {sfConn, apiVersion, setupColorListeners} from "./inspector.js";
/* global initButton */
import {copyToClipboard, initScrollTable} from "./data-load.js";

class QueryHistory {
  constructor(storageKey, max) {
    this.storageKey = storageKey;
    this.max = max;
    this.list = this._get();
  }

  _get() {
    let history;
    try {
      history = JSON.parse(localStorage[this.storageKey]);
    } catch (e) {
      // empty
    }
    if (!Array.isArray(history)) {
      history = [];
    }
    // A previous version stored just strings. Skip entries from that to avoid errors.
    history = history.filter(e => typeof e == "object");
    this.sort(this.storageKey, history);
    return history;
  }

  add(entry) {
    let history = this._get();
    let historyIndex = history.findIndex(e => e.endpoint == entry.endpoint);
    if (historyIndex > -1) {
      history.splice(historyIndex, 1);
    }
    history.splice(0, 0, entry);
    if (history.length > this.max) {
      history.pop();
    }
    localStorage[this.storageKey] = JSON.stringify(history);
    this.sort(this.storageKey, history);
  }

  remove(entry) {
    let history = this._get();
    let historyIndex = history.findIndex(e => e.endpoint == entry.endpoint);
    if (historyIndex > -1) {
      history.splice(historyIndex, 1);
    }
    localStorage[this.storageKey] = JSON.stringify(history);
    this.sort(this.storageKey, history);
  }

  clear() {
    localStorage.removeItem(this.storageKey);
    this.list = [];
  }

  sort(storageKey, history) {
    if (storageKey === "restSavedQueryHistory") {
      history.sort((a, b) => (a.endpoint > b.endpoint) ? 1 : ((b.endpoint > a.endpoint) ? -1 : 0));
    }
    this.list = history;
  }
}

class Model {
  constructor({sfHost, args}) {
    this.sfHost = sfHost;
    this.apiUrls = null;
    this.initialEndpoint = "";
    this.sfLink = "https://" + sfHost;
    this.spinnerCount = 0;
    this.userInfo = "...";
    this.winInnerHeight = 0;
    this.autocompleteResults = {sobjectName: "", title: "\u00A0", results: []};
    this.autocompleteClick = null;
    this.isWorking = false;
    this.exportStatus = "";
    this.exportError = null;
    this.exportedData = null;
    this.queryHistory = new QueryHistory("restQueryHistory", 100);
    this.selectedHistoryEntry = null;
    this.savedHistory = new QueryHistory("restSavedQueryHistory", 50);
    this.selectedSavedEntry = null;
    this.expandSavedOptions = false;
    this.startTime = null;
    this.totalTime = 0;
    this.autocompleteState = "";
    this.autocompleteProgress = {};
    this.exportProgress = {};
    this.queryName = "";
    this.apiResponse = null;
    this.canSendRequest = true;
    this.resultClass = "neutral";
    this.request = {endpoint: "", method: "get", body: ""};
    this.apiList;
    this.filteredApiList;
    this.requestTemplates = localStorage.getItem("requestTemplates") ? this.requestTemplates = localStorage.getItem("requestTemplates").split("//") : [
      {key: "getLimit", endpoint: `/services/data/v${apiVersion}/limits`, method: "GET", body: ""},
      {key: "getAccount", endpoint: `/services/data/v${apiVersion}/query/?q=SELECT+Id,Name+FROM+Account+LIMIT+1`, method: "GET", body: ""},
      {key: "createAccount", endpoint: `/services/data/v${apiVersion}/sobjects/Account/`, method: "POST", body: '{  \n"Name" : "SFIR",\n"Industry" : "Chrome Extension"\n}'},
      {key: "updateAccount", endpoint: `/services/data/v${apiVersion}/sobjects/Account/001XXXXXXX`, method: "PATCH", body: '{  \n"Name" : "SFIR Updated"\n}'},
      {key: "deleteccount", endpoint: `/services/data/v${apiVersion}/sobjects/Account/001XXXXXXX`, method: "DELETE", body: ""}
    ];
    this.selectedTemplate = "";

    this.spinFor(sfConn.soap(sfConn.wsdl(apiVersion, "Partner"), "getUserInfo", {}).then(res => {
      this.userInfo = res.userFullName + " / " + res.userName + " / " + res.organizationName;
    }));

    if (args.has("endpoint") && args.has("method")) {
      this.request.endpoint = args.get("endpoint");
      this.request.method = args.get("method");
    } else if (this.queryHistory.list[0]) {
      this.request = this.queryHistory.list[0];
      this.didUpdate();
    } else {
      this.request = this.requestTemplates[0];
    }

    this.spinFor(sfConn.rest(`/services/data/v${apiVersion}/`, {})
      .catch(err => {
        if (err.name != "AbortError") {
          this.autocompleteResults = {
            title: "Error: " + err.message,
            results: []
          };
        }
        return null;
      })
      .then((result) => {
        this.apiList = Object.keys(result)
          .map(key => ({
            key,
            "endpoint": result[key]
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
      }));

    if (args.has("error")) {
      this.exportError = args.get("error") + " " + args.get("error_description");
    }
  }
  updatedExportedData() {
    this.resultTableCallback(this.exportedData);
  }
  setQueryName(value) {
    this.queryName = value;
  }
  toggleSavedOptions() {
    this.expandSavedOptions = !this.expandSavedOptions;
  }
  showDescribeUrl() {
    let args = new URLSearchParams();
    args.set("host", this.sfHost);
    args.set("objectType", this.autocompleteResults.sobjectName);
    return "inspect.html?" + args;
  }
  clearHistory() {
    this.queryHistory.clear();
  }
  copyAsJson() {
    copyToClipboard(this.apiResponse.value, null, "  ");
  }
  clear(){
    this.apiResponse.value = "";
  }
  selectSavedEntry() {
    let delimiter = ":";
    if (this.selectedSavedEntry != null) {
      let queryStr = "";
      if (this.selectedSavedEntry.query.includes(delimiter)) {
        let query = this.selectedSavedEntry.query.split(delimiter);
        this.queryName = query[0];
        queryStr = this.selectedSavedEntry.query.substring(this.selectedSavedEntry.query.indexOf(delimiter) + 1);
      } else {
        queryStr = this.selectedSavedEntry.query;
      }
      this.request.endpoint = queryStr;
      this.queryAutocompleteHandler();
      this.selectedSavedEntry = null;
    }
  }
  clearSavedHistory() {
    this.savedHistory.clear();
  }
  addToHistory() {
    this.request.key = Date.now();
    this.request.label = this.queryName ? this.queryName : "";
    this.savedHistory.add(this.request);
  }
  removeFromHistory() {
    this.savedHistory.remove(this.request);
  }
  /**
   * Notify React that we changed something, so it will rerender the view.
   * Should only be called once at the end of an event or asynchronous operation, since each call can take some time.
   * All event listeners (functions starting with "on") should call this function if they update the model.
   * Asynchronous operations should use the spinFor function, which will call this function after the asynchronous operation completes.
   * Other functions should not call this function, since they are called by a function that does.
   * @param cb A function to be called once React has processed the update.
   */
  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
    if (this.testCallback) {
      this.testCallback();
    }
  }
  /**
   * Show the spinner while waiting for a promise.
   * didUpdate() must be called after calling spinFor.
   * didUpdate() is called when the promise is resolved or rejected, so the caller doesn't have to call it, when it updates the model just before resolving the promise, for better performance.
   * @param promise The promise to wait for.
   */
  spinFor(promise) {
    this.spinnerCount++;
    promise
      .catch(err => {
        console.error("spinFor", err);
      })
      .then(() => {
        this.spinnerCount--;
        this.didUpdate();
      })
      .catch(err => console.log("error handling failed", err));
  }

  doSend() {
    this.startTime = performance.now();
    this.canSendRequest = false;
    this.spinFor(sfConn.rest(this.request.endpoint, {method: this.request.method, body: this.request.body, bodyType: "raw", progressHandler: this.autocompleteProgress}, true)
      .catch(err => {
        this.canSendRequest = true;
        this.totalTime = performance.now() - this.startTime;
        if (err.name != "AbortError") {
          this.autocompleteResults = {
            title: "Error: " + err.message,
            results: []
          };
        }
        return null;
      })
      .then((result) => {
        //generate key with timestamp
        this.totalTime = performance.now() - this.startTime;
        this.request.key = Date.now();
        this.queryHistory.add(this.request);
        if (!result) {
          model.didUpdate();
          return;
        }
        this.parseResponse(result, "Success");
        this.canSendRequest = true;
      }));
  }

  parseResponse(result, status) {

    this.resultClass = result.status < 300 ? "success" : result.status > 399 ? "error" : "";
    this.apiResponse = {
      status,
      code: result.status,
      value: result.response ? JSON.stringify(result.response, null, "    ") : "NONE"
    };
    if (this.resultClass === "success"){
      let newApis = Object.keys(result.response)
        .filter(key => typeof result.response[key] == "string" && result.response[key].startsWith("/services/data/"))
        .map(key => ({
          key,
          "endpoint": result.response[key]
        }));
      newApis.forEach(api => {
        if (!this.apiList.some(existingApi => existingApi.key === api.key)) {
          this.apiList.push(api);
        }
      });
      this.filteredApiList = this.apiList.filter(api => api.endpoint.toLowerCase().includes(this.request.endpoint.toLowerCase()));
    }
  }
}


let h = React.createElement;

class App extends React.Component {
  constructor(props) {
    super(props);
    setupColorListeners();
    this.onSelectHistoryEntry = this.onSelectHistoryEntry.bind(this);
    this.onSelectRequestTemplate = this.onSelectRequestTemplate.bind(this);
    this.onSelectQueryMethod = this.onSelectQueryMethod.bind(this);
    this.onClearHistory = this.onClearHistory.bind(this);
    this.onSelectSavedEntry = this.onSelectSavedEntry.bind(this);
    this.onAddToHistory = this.onAddToHistory.bind(this);
    this.onRemoveFromHistory = this.onRemoveFromHistory.bind(this);
    this.onClearSavedHistory = this.onClearSavedHistory.bind(this);
    this.onToggleSavedOptions = this.onToggleSavedOptions.bind(this);
    this.onSend = this.onSend.bind(this);
    this.onCopyAsJson = this.onCopyAsJson.bind(this);
    this.onClearResponse = this.onClearResponse.bind(this);
    this.onUpdateBody = this.onUpdateBody.bind(this);
    this.onSetQueryName = this.onSetQueryName.bind(this);
    this.onSetEndpoint = this.onSetEndpoint.bind(this);
  }
  onSelectEntry(e, list) {
    let {model} = this.props;
    model.request = list.filter(template => template.key.toString() === e.target.value)[0];
    this.refs.endpoint.value = model.request.endpoint;
    this.resetRequest(model);
    model.didUpdate();
  }
  onSelectHistoryEntry(e) {
    let {model} = this.props;
    this.onSelectEntry(e, model.queryHistory.list);
  }
  onSelectRequestTemplate(e) {
    let {model} = this.props;
    this.onSelectEntry(e, model.requestTemplates);
  }
  onSelectSavedEntry(e) {
    let {model} = this.props;
    this.onSelectEntry(e, model.savedHistory.list);
  }
  resetRequest(model){
    model.apiResponse = "";
    this.refs.resultBar.classList.remove("success");
    this.refs.resultBar.classList.remove("error");
    model.didUpdate();
  }
  onSelectQueryMethod(e){
    let {model} = this.props;
    model.request.method = e.target.value;
    this.canSendRequest();
    model.didUpdate();
  }
  onClearHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to clear the query history?");
    if (r == true) {
      let {model} = this.props;
      model.clearHistory();
      model.didUpdate();
    }
  }
  onAddToHistory(e) {
    e.preventDefault();
    let {model} = this.props;
    model.addToHistory();
    model.didUpdate();
  }
  onRemoveFromHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to remove this saved query?");
    let {model} = this.props;
    if (r == true) {
      model.removeFromHistory();
    }
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onClearSavedHistory(e) {
    e.preventDefault();
    let r = confirm("Are you sure you want to remove all saved queries?");
    let {model} = this.props;
    if (r == true) {
      model.clearSavedHistory();
    }
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onToggleSavedOptions(e) {
    e.preventDefault();
    let {model} = this.props;
    model.toggleSavedOptions();
    model.didUpdate();
  }
  onSend() {
    let {model} = this.props;
    model.doSend();
    model.didUpdate();
  }
  onCopyAsJson() {
    let {model} = this.props;
    model.copyAsJson();
    model.didUpdate();
  }
  onClearResponse(){
    let {model} = this.props;
    model.clear();
    model.didUpdate();
  }
  onUpdateBody(e){
    let {model} = this.props;
    model.request.body = e.target.value;
    this.canSendRequest();
    model.didUpdate();
  }
  onSetQueryName(e) {
    let {model} = this.props;
    model.setQueryName(e.target.value);
    model.didUpdate();
  }
  onSetEndpoint(e){
    let {model} = this.props;
    model.request.endpoint = e.target.value;
    //replace current endpoint with latest on the have the autocomplete works for all api versions
    let updatedApiEndpoint = e.target.value.replace(/\/data\/v\d+\.0\//, `/data/v${apiVersion}/`);
    model.filteredApiList = model.apiList.filter(api => api.endpoint.toLowerCase().includes(updatedApiEndpoint.toLowerCase()));
    model.didUpdate();
  }
  componentDidMount() {
    let {model} = this.props;
    let endpointInput = this.refs.endpoint;
    endpointInput.value = model.request.endpoint;

    addEventListener("keydown", e => {
      if ((e.ctrlKey && e.key == "Enter") || e.key == "F5") {
        e.preventDefault();
        model.doSend();
        model.didUpdate();
      }
    });

    this.scrollTable = initScrollTable(this.refs.scroller);
    model.resultTableCallback = this.scrollTable.dataChange;

    let recalculateHeight = this.recalculateSize.bind(this);
    if (!window.webkitURL) {
      // Firefox
      // Firefox does not fire a resize event. The next best thing is to listen to when the browser changes the style.height attribute.
      new MutationObserver(recalculateHeight).observe(endpointInput, {attributes: true});
    } else {
      // Chrome
      // Chrome does not fire a resize event and does not allow us to get notified when the browser changes the style.height attribute.
      // Instead we listen to a few events which are often fired at the same time.
      // This is not required in Firefox, and Mozilla reviewers don't like it for performance reasons, so we only do this in Chrome via browser detection.
      endpointInput.addEventListener("mousemove", recalculateHeight);
      addEventListener("mouseup", recalculateHeight);
    }
    function resize() {
      model.winInnerHeight = innerHeight;
      model.didUpdate(); // Will call recalculateSize
    }
    addEventListener("resize", resize);
    resize();
  }
  componentDidUpdate() {
    this.recalculateSize();
    if (window.Prism) {
      window.Prism.highlightAll();
    }
  }
  canSendRequest(){
    let {model} = this.props;
    model.canSendRequest = model.request.method === "GET" || model.request.body.length > 1;
  }
  autocompleteClick(value){
    let {model} = this.props;
    model.request.method = "GET";
    this.refs.endpoint.value = value.endpoint;
    model.request.endpoint = value.endpoint;
    model.request.body = "";
    model.filteredApiList = [];
    model.didUpdate();
  }
  recalculateSize() {
    //TODO
    // Investigate if we can use the IntersectionObserver API here instead, once it is available.
    //this.scrollTable.viewportChange();
  }
  toggleQueryMoreMenu(){
    this.refs.buttonQueryMenu.classList.toggle("slds-is-open");
  }
  render() {
    let {model} = this.props;
    return h("div", {},
      h("div", {id: "user-info"},
        h("a", {href: model.sfLink, className: "sf-link"},
          h("svg", {viewBox: "0 0 24 24"},
            h("path", {d: "M18.9 12.3h-1.5v6.6c0 .2-.1.3-.3.3h-3c-.2 0-.3-.1-.3-.3v-5.1h-3.6v5.1c0 .2-.1.3-.3.3h-3c-.2 0-.3-.1-.3-.3v-6.6H5.1c-.1 0-.3-.1-.3-.2s0-.2.1-.3l6.9-7c.1-.1.3-.1.4 0l7 7v.3c0 .1-.2.2-.3.2z"})
          ),
          " Salesforce Home"
        ),
        h("h1", {}, "REST Explore"),
        h("span", {}, " / " + model.userInfo),
        h("div", {className: "flex-right"},
          h("div", {id: "spinner", role: "status", className: "slds-spinner slds-spinner_small slds-spinner_inline", hidden: model.spinnerCount == 0},
            h("span", {className: "slds-assistive-text"}),
            h("div", {className: "slds-spinner__dot-a"}),
            h("div", {className: "slds-spinner__dot-b"}),
          )
        ),
      ),
      h("div", {className: "area"},
        h("div", {className: "area-header"},
        ),
        h("div", {className: "query-controls"},
          h("h1", {}, "Request"),
          h("div", {className: "query-history-controls"},
            h("select", {value: model.selectedTemplate, onChange: this.onSelectRequestTemplate, className: "query-template", title: "Check documentation to customize templates"},
              h("option", {value: null, disabled: true, defaultValue: true, hidden: true}, "Templates"),
              model.requestTemplates.map(req => h("option", {key: req.key, value: req.key}, req.method + " " + req.endpoint))
            ),
            h("div", {className: "button-group"},
              h("select", {value: JSON.stringify(model.selectedHistoryEntry), onChange: this.onSelectHistoryEntry, className: "query-history"},
                h("option", {value: JSON.stringify(null), disabled: true}, "History"),
                model.queryHistory.list.map(q => h("option", {key: JSON.stringify(q), value: q.key}, q.method + " " + q.endpoint))
              ),
              h("button", {onClick: this.onClearHistory, title: "Clear Request History"}, "Clear")
            ),
            h("div", {className: "button-group"},
              h("select", {value: JSON.stringify(model.selectedSavedEntry), onChange: this.onSelectSavedEntry, className: "query-history"},
                h("option", {value: JSON.stringify(null), disabled: true}, "Saved"),
                model.savedHistory.list.map(q => h("option", {key: JSON.stringify(q), value: q.key}, q.label + " " + q.method + " " + q.endpoint))
              ),
              h("span", {id: "save-wrapper"},
                h("svg", {viewBox: "0 0 122.73 122.88", x: "0px", y: "0px", style: {enableBackground: "new 0 0 122.73 122.88"}},
                  h("path", {style: {fillRule: "evenodd", clipRule: "evenodd"}, d: "M109.5,113.68L109.5,113.68l-6.09,0c-0.4,0-0.73-0.32-0.73-0.72V69.48l0-0.1c0-0.9-0.17-1.65-0.49-2.22 c-0.06-0.11-0.14-0.22-0.2-0.31c-0.06-0.09-0.16-0.18-0.23-0.27l-0.02-0.02c-0.3-0.3-0.68-0.53-1.12-0.69l-0.25-0.07l-0.04-0.01 l-0.01,0c-0.41-0.11-0.88-0.17-1.38-0.17h-0.05l-0.08,0H36.75c-0.89,0-1.62,0.17-2.18,0.49l-0.02,0.01l-0.27,0.17l-0.04,0.04 c-0.09,0.07-0.18,0.15-0.27,0.23l-0.02,0.02l-0.01,0.01c-0.62,0.63-0.92,1.57-0.92,2.82l0,0.04l0,43.54h0 c0,0.4-0.33,0.72-0.73,0.72l-9.85,0c0,0,0,0,0,0c-0.19,0-0.38-0.08-0.51-0.21L9.87,101.41c-0.18-0.14-0.29-0.36-0.29-0.59l0-87.91 l0-0.08c0-0.83,0.15-1.52,0.44-2.07l0,0c0.05-0.11,0.11-0.2,0.17-0.29l0.02-0.03c0.07-0.11,0.19-0.18,0.25-0.29l0.01-0.02 l0.02-0.02l0,0c0.25-0.25,0.57-0.45,0.92-0.59l0.04-0.02l0.02-0.01l0.02-0.01l0.18-0.06v0l0.01-0.01c0.42-0.14,0.9-0.2,1.44-0.21 l0.09-0.01l26.21,0c0.4,0,0.73,0.32,0.73,0.72v28.75c0,0.52,0.05,1.03,0.13,1.5c0.09,0.46,0.15,0.98,0.39,1.34l0.01,0.02l0,0.01v0 c0.18,0.44,0.42,0.87,0.67,1.25c0.24,0.37,0.56,0.77,0.9,1.13l0.02,0.02l0,0.01l0.01,0c0.48,0.5,0.94,1.15,1.62,1.27l0.01,0l0.01,0 l0.01,0.01l0.32,0.17l0,0l0.4,0.18v0l0.01,0l0,0l0,0v0c0.33,0.14,0.67,0.26,1,0.34l0.01,0l0.03,0l0.01,0l0.03,0l0.26,0.05v0 c0.45,0.09,0.93,0.14,1.42,0.14l0.02,0h47.8c1.03,0,1.98-0.18,2.85-0.53l0.01-0.01c0.87-0.36,1.67-0.9,2.39-1.61l0.03-0.03 c0.36-0.36,0.69-0.75,0.96-1.16c0.26-0.38,0.58-0.76,0.66-1.22l0-0.01l0.01-0.01l0.01-0.02c0.18-0.43,0.34-0.88,0.41-1.34l0-0.03 c0.09-0.47,0.13-0.97,0.13-1.49V9.92c0-0.4,0.33-0.73,0.73-0.73h6c0.58,0,1.09,0.07,1.54,0.21c0.48,0.15,0.89,0.39,1.2,0.7 c0.68,0.67,0.88,1.67,0.9,2.59l0.01,0.09v0.05l0,0.02v97.19c0,0.56-0.07,1.07-0.21,1.51l-0.01,0.03v0l0,0.02l-0.08,0.22l0,0 l-0.02,0.06l-0.09,0.2l-0.01,0.04l-0.02,0.04l0,0l-0.03,0.06l-0.15,0.22l0,0l-0.05,0.08l-0.14,0.17l-0.06,0.07 c-0.15,0.16-0.33,0.3-0.53,0.42c-0.17,0.1-0.36,0.19-0.55,0.26l-0.06,0.02c-0.16,0.05-0.34,0.1-0.53,0.14l-0.02,0l-0.01,0l-0.02,0 l-0.09,0.01l-0.02,0l0,0l-0.02,0c-0.22,0.03-0.49,0.05-0.76,0.06H109.5L109.5,113.68z M53.93,104.43c-1.66,0-3-1.34-3-3 c0-1.66,1.34-3,3-3h31.12c1.66,0,3,1.34,3,3c0,1.66-1.34,3-3,3H53.93L53.93,104.43z M53.93,89.03c-1.66,0-3-1.34-3-3s1.34-3,3-3 h31.12c1.66,0,3,1.34,3,3s-1.34,3-3,3H53.93L53.93,89.03z M94.03,9.39l-45.32-0.2v25.86H48.7c0,0.46,0.06,0.86,0.17,1.2 c0.03,0.06,0.04,0.1,0.07,0.15c0.09,0.23,0.22,0.44,0.4,0.61l0.03,0.03v0c0.06,0.06,0.11,0.1,0.17,0.15 c0.06,0.05,0.13,0.09,0.2,0.14c0.39,0.23,0.92,0.34,1.58,0.34v0l40.1,0.25v0l0,0v0c0.91,0,1.57-0.21,1.98-0.63 c0.42-0.43,0.63-1.1,0.63-2.02h0V9.39L94.03,9.39z M41.91,73.23h53.07v0c0.35,0,0.65,0.29,0.65,0.64l0,39.17 c0,0.35-0.29,0.65-0.65,0.65H41.91v0c-0.35,0-0.65-0.29-0.65-0.64l0-39.17C41.26,73.52,41.56,73.23,41.91,73.23L41.91,73.23 L41.91,73.23z M9.68,0h104.26c4.91,0,8.79,3.86,8.79,8.79V114c0,4.95-3.9,8.88-8.79,8.88l-96.61,0l-0.24-0.25L1.05,106.6L0,105.9 V8.76C0,3.28,4.81,0,9.68,0L9.68,0L9.68,0z"})
                ),
                h("input", {placeholder: "Query Label", type: "save", value: model.queryName, onInput: this.onSetQueryName}),
              ),
              h("button", {onClick: this.onAddToHistory, title: "Add request to saved history"}, "Save Query"),
              h("div", {ref: "buttonQueryMenu", className: "slds-dropdown-trigger slds-dropdown-trigger_click slds-button_last"},
                h("button", {className: "slds-button slds-button_icon slds-button_icon-border-filled", onMouseEnter: () => this.toggleQueryMoreMenu(), title: "Show more options"},
                  h("svg", {className: "slds-button__icon"},
                    h("use", {xlinkHref: "symbols.svg#down"})
                  ),
                  h("span", {className: "slds-assistive-text"}, "Show more options")
                ),
                h("div", {className: "slds-dropdown slds-dropdown_right", onMouseLeave: () => this.toggleQueryMoreMenu()},
                  h("ul", {className: "slds-dropdown__list", role: "menu"},
                    h("li", {className: "slds-dropdown__item", role: "presentation"},
                      h("a", {onClick: () => console.log("menu item click"), target: "_blank", tabIndex: "0"},
                        h("span", {className: "slds-truncate"},
                          h("span", {className: "slds-truncate blue", onClick: this.onRemoveFromHistory, title: "Remove query from saved history"}, "Remove Saved Query")
                        )
                      )
                    ),
                    h("li", {className: "slds-dropdown__item", role: "presentation"},
                      h("a", {onClick: () => console.log("menu item click"), target: "_blank", tabIndex: "0"},
                        h("span", {className: "slds-truncate"},
                          h("span", {className: "slds-truncate blue", onClick: this.onClearSavedHistory, title: "Clear saved history"}, "Clear Saved Queries")
                        )
                      )
                    )
                  )
                )
              ),
            ),
          ),
        ),
        h("div", {className: "query-controls slds-form-element__control"},
          h("select", {value: model.request.method, onChange: this.onSelectQueryMethod, className: "query-history slds-m-right_medium", title: "Choose rest method"},
            h("option", {key: "get", value: "GET"}, "GET"),
            h("option", {key: "post", value: "POST"}, "POST"),
            h("option", {key: "put", value: "PUT"}, "PUT"),
            h("option", {key: "patch", value: "PATCH"}, "PATCH"),
            h("option", {key: "delete", value: "DELETE"}, "DELETE")
          ),
          h("input", {ref: "endpoint", className: "slds-input query-control slds-m-right_medium", type: "default", placeholder: "/services/data/v" + apiVersion, onChange: this.onSetEndpoint}),
          h("div", {className: "flex-right"},
            h("button", {tabIndex: 1, disabled: !model.canSendRequest, onClick: this.onSend, title: "Ctrl+Enter / F5", className: "highlighted"}, "Send")
          )
        ),
        h("div", {className: "autocomplete-box"},
          h("div", {className: "autocomplete-header"}),
          h("div", {className: "autocomplete-results"},
            model.filteredApiList?.length > 0 ? model.filteredApiList.map(r =>
              h("div", {className: "autocomplete-result", key: r.key}, h("a", {tabIndex: 0, title: r.key, onClick: e => { e.preventDefault(); this.autocompleteClick(r); model.didUpdate(); }, href: "#", className: "fieldName url"}, h("div", {className: "autocomplete-icon"}), r.key), " ")
            ) : null
          ),
        ),
        h("div", {className: "autocomplete-box slds-m-top_medium"},
          h("h1", {className: ""}, "Request Body"),
          h("div", {className: "slds-m-top_small"},
            h("textarea", {className: "request-body", value: model.request.body, onChange: this.onUpdateBody})
          )
        )
      ),
      h("div", {className: "area", id: "result-area"},
        h("div", {ref: "resultBar", className: `result-bar ${model.resultClass}`},
          h("h1", {}, "Response"),
          h("div", {className: "button-group"},
            h("button", {disabled: !model.apiResponse, onClick: this.onCopyAsJson, title: "Copy raw API output to clipboard"}, "Copy")
          ),
          h("span", {className: "result-status flex-right"},
            model.apiResponse && h("div",
              h("span", {}, model.totalTime.toFixed(1) + "ms"),
              h("span", {className: "slds-m-left_medium status-code"}, "Status: " + model.apiResponse.code)
            ),
            h("div", {className: "slds-m-left_medium button-group"},
              h("button", {disabled: !model.apiResponse, onClick: this.onClearResponse, title: "Clear Response"}, "Clear")
            )
          )
        ),
        h("textarea", {id: "result-text", readOnly: true, value: model.exportError || "", hidden: model.exportError == null}),
        h("div", {id: "result-table", ref: "scroller", hidden: model.exportError != null},
          model.apiResponse && h("div", {},
            h("pre", {className: "language-json reset-margin"}, // Set the language class to JSON for Prism to highlight
              h("code", {className: "language-json"}, model.apiResponse.value)
            )
          )
        )
      )
    );
  }
}

{

  let args = new URLSearchParams(location.search);
  let sfHost = args.get("host");
  let hash = new URLSearchParams(location.hash); //User-agent OAuth flow
  if (!sfHost && hash) {
    sfHost = decodeURIComponent(hash.get("instance_url")).replace(/^https?:\/\//i, "");
  }
  initButton(sfHost, true);
  sfConn.getSession(sfHost).then(() => {

    let root = document.getElementById("root");
    let model = new Model({sfHost, args});
    model.reactCallback = cb => {
      ReactDOM.render(h(App, {model}), root, cb);
    };
    ReactDOM.render(h(App, {model}), root);

    if (parent && parent.isUnitTest) { // for unit tests
      parent.insextTestLoaded({model, sfConn});
    }
  });

}