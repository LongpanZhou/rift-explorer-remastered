/**
 * Builds the Swagger spec for the League client's local API.
 * Originally written by @Pupix (rift-explorer 2.0.1).
 */
import mixin from "mixin-deep";
import { buildCatalogPaths } from "./catalogPaths";
import { lcuClient } from "./player";

interface createSpecInterface {
  address: string;
  port: number;
  password: string;
}

/**
 * The schema of one map value or vector item: an object, a string, a number, or a
 * reference to another definition.
 */
function elementSchema(elementType: string): object {
  if (elementType === "object") return { additionalProperties: true, type: "object" };
  if (elementType === "string") return { type: "string" };
  if (/^u?int/.test(elementType)) return { format: elementType, type: "integer" };
  if (elementType === "double" || elementType === "float") return { format: elementType, type: "number" };
  return { $ref: `#/definitions/${elementType}` };
}

/**
 * @param address
 * @param port
 * @param password
 * @returns {Promise<{basePath: string, paths: {}, host: string, produces: [string, string, string], schemes: [*], definitions: {}, swagger: string, consumes, info: {description: string, title: string, version: *}}>}
 */
export default async ({
  address = "127.0.0.1",
  port,
  password,
}: createSpecInterface): Promise<any> => {
  const client = lcuClient({ address, port, password });
  const [helpConsole, helpFull, builds] = await Promise.all([
    client.get("/help?format=Console"),
    client.get("/help?format=Full"),
    client.get("/system/v1/builds"),
  ]);
  const swagger = {
    host: `${address}:${port}`,
    schemes: ["https"],

    consumes: [
      "application/json",
      "application/vnd.api+json",
      "application/x-yaml",
      "application/x-msgpack",
      "application/octet-stream",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ],
    definitions: {},
    paths: {},
    info: {
      description: "Always up to date LCU API documentation",
      title: "Rift Explorer 7",
      version: builds.version,
    },
    produces: [
      "application/json",
      "application/x-yaml",
      "application/x-msgpack",
    ],
    swagger: "2.0",
    components: {
      securitySchemes: {
        basicAuth: {
          type: "http",
          scheme: "basic",
        },
      },
    },
    security: {
      basicAuth: [],
    },
  };

  // Mix helps to get a more complete version
  const funcs = {};
  const types = {};
  const events = {};
  helpFull.functions.forEach((func) => {
    funcs[func.name] = func;
  });
  helpFull.types.forEach((type) => {
    types[type.name] = type;
  });
  helpFull.events.forEach((event) => {
    events[event.name] = event;
  });
  helpFull.functions = funcs;
  helpFull.types = types;
  helpFull.events = events;

  const help = mixin({}, helpConsole, helpFull);

  Object.keys(help.types).forEach((type) => {
    swagger.definitions[type] = {};

    if (help.types[type].description) {
      swagger.definitions[type].description = help.types[type].description;
    }

    // Object
    if (help.types[type].fields) {
      swagger.definitions[type].properties = {};

      help.types[type].fields.forEach((field) => {
        const prop: any = { type: field.type.type };
        swagger.definitions[type].properties[field.name] = prop;

        if (field.description) {
          prop.description = field.description;
        }

        const elementType = field.type.elementType;
        if (/^u?int/.test(prop.type)) {
          prop.format = prop.type;
          prop.type = "integer";
        } else if (prop.type === "double" || prop.type === "float") {
          prop.format = prop.type;
          prop.type = "number";
        } else if (prop.type === "bool") {
          prop.type = "boolean";
        } else if (prop.type === "object") {
          prop.additionalProperties = true;
        } else if (prop.type === "map") {
          prop.type = "object";
          prop.additionalProperties = elementSchema(elementType);
        } else if (prop.type === "vector") {
          prop.type = "array";
          prop.items = elementSchema(elementType);
        } else if (prop.type !== "string") {
          // A reference to another definition
          prop.$ref = `#/definitions/${prop.type}`;
          delete prop.type;
        }
      });

      swagger.definitions[type].type = "object";
    }

    // String
    if (help.types[type].values && help.types[type].values.length) {
      swagger.definitions[type].type = "string";
      swagger.definitions[type].enum = [];

      help.types[type].values.forEach((value) => {
        swagger.definitions[type].enum[value.value] = value.name;
      });

      swagger.definitions[type].enum = swagger.definitions[type].enum.filter(
        (item) => !!item
      );
    }
  });

  swagger.paths = buildCatalogPaths();

  return swagger;
};
/* eslint-enable */
