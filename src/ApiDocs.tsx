// The Node shims must load before swagger-ui; this module is loaded only when
// Developer mode is first opened, so Player mode never pays for swagger-ui.
import "./polyfills";
import { useEffect, useState } from "react";
import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import { invokeJson, type SidecarError } from "./errors";
import StatusError from "./StatusError";

export default function ApiDocs() {
  const [spec, setSpec] = useState<object | null>(null);
  const [error, setError] = useState<SidecarError | null>(null);

  const load = () => {
    setError(null);
    invokeJson("get_spec").then(setSpec).catch(setError);
  };
  useEffect(load, []);

  if (error) return <StatusError error={error} retry={load} />;
  if (!spec) return <p className="status">Loading the League client API...</p>;

  // Try it out is off: the docs view only describes the API.
  return <SwaggerUI spec={spec} supportedSubmitMethods={[]} docExpansion="list" />;
}
