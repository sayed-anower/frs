/* frs/src/rules/int_rules.js — interpreter lookup tables (pure data, no logic).
 * HTTP_STATUS / HTTP_ROUTE_METHODS used to live inline in interpreter.js;
 * they live here now so runtime mappings stay editable without touching
 * the engine. The engine falls back to built-ins if this file is absent.
 * Pure JS, no deps. Node: require('./int_rules.js'). Browser: FRS_rules_int.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.FRS_rules_int = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // actix-web style constructor statuses: HttpResponse::Ok() / ::NotFound() / ...
  var HTTP_STATUS = {
    Ok: 200, Created: 201, Accepted: 202, NoContent: 204,
    MovedPermanently: 301, Found: 302, SeeOther: 303, NotModified: 304,
    TemporaryRedirect: 307, PermanentRedirect: 308,
    BadRequest: 400, Unauthorized: 401, PaymentRequired: 402, Forbidden: 403,
    NotFound: 404, MethodNotAllowed: 405, Conflict: 409, Gone: 410,
    UnprocessableEntity: 422, InternalServerError: 500, NotImplemented: 501,
    BadGateway: 502, ServiceUnavailable: 503, GatewayTimeout: 504
  };
  // route-attr macros: #[get("/")] / #[post(..)] / #[route(..)] / ...
  var HTTP_ROUTE_METHODS = {
    get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', head: 'HEAD',
    options: 'OPTIONS', patch: 'PATCH', trace: 'TRACE', connect: 'CONNECT'
  };

  return { HTTP_STATUS: HTTP_STATUS, HTTP_ROUTE_METHODS: HTTP_ROUTE_METHODS };
}));
