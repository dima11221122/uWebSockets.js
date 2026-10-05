const { text } = require('./util');

class HttpRequest {
  constructor(request, route, match) {
    this.request = request;
    const start = request.url.indexOf('/', request.url.indexOf('://') + 3);
    const full = start < 0 ? '/' : request.url.slice(start);
    const question = full.indexOf('?');
    this.path = question < 0 ? full : full.slice(0, question);
    this.query = question < 0 ? '' : full.slice(question + 1);
    this.setRoute(route, match);
  }
  setRoute(route, match) {
    this.parameters = match?.slice(1) ?? [];
    this.names = route?.names ?? [];
    this.yielded = false;
  }
  getHeader(name) { return this.request.headers.get(text(name)) ?? ''; }
  getUrl() { return this.path; }
  getMethod() { return this.request.method.toLowerCase(); }
  getCaseSensitiveMethod() { return this.request.method; }
  getQuery(name) {
    if (name === undefined) return this.query;
    this.search ??= new URLSearchParams(this.query);
    return this.search.get(text(name)) ?? undefined;
  }
  getParameter(index) { return this.parameters[typeof index === 'number' ? index : this.names.indexOf(text(index))]; }
  forEach(callback) { this.request.headers.forEach((value, key) => callback(key, value)); }
  setYield(value) { this.yielded = Boolean(value); return this; }
}

module.exports = HttpRequest;
