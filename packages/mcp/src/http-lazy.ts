/**
 * Lazy-loaded Streamable HTTP entry. Built by tsdown as its own self-contained chunk
 * (`dist/http-lazy.js`) and reached only via `import("./http-lazy.js")` from `cli-main.ts`, so
 * the default stdio path never pays for the HTTP transport and the eager `cli.js + cli-main.js`
 * budget is unaffected.
 */
export {
  authorize,
  HTTP_BODY_MAX_BYTES,
  HTTP_DEFAULT_HOST,
  HTTP_SESSION_IDLE_MS,
  HTTP_TOKEN_ENV_DEFAULT,
  type HttpHandle,
  isLoopbackHost,
  parseHostPort,
  type ServerFactory,
  type StartHttpOptions,
  startHttp,
} from "./http.js";
