import { LCU_ENDPOINTS, LcuEndpoint } from "./endpointCatalog";

/**
 * Builds Swagger paths from the endpoint catalog (verified against the live
 * client build in endpointCatalog.ts). The client's /help output no longer
 * includes REST URLs, so the paths can't be derived from it.
 */
export const buildCatalogPaths = (
  endpoints: LcuEndpoint[] = LCU_ENDPOINTS
): Record<string, any> => {
  const paths: Record<string, any> = {};

  endpoints.forEach((endpoint) => {
    const tag = endpoint.path.split("/")[1] || "untagged";
    const parameters = endpoint.query.map((param) => ({
      in: "query",
      name: param.name,
      required: param.required,
      type: "string",
      description: param.array
        ? 'JSON array, for example ["value"], URL-encoded when sent'
        : undefined,
    }));

    paths[endpoint.path] = {};
    endpoint.methods.forEach((method) => {
      paths[endpoint.path][method.toLowerCase()] = {
        summary: `[${endpoint.status}] ${endpoint.summary}`,
        tags: [tag],
        parameters,
        responses: { 200: { description: "Response from the live client" } },
      };
    });
  });

  return paths;
};
