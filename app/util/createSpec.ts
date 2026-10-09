/**
 * Builds the Swagger spec for the League client's local API.
 * Originally written by @Pupix (rift-explorer 2.0.1).
 */
import { Agent } from "https";

import mixin from "mixin-deep";
import { buildCatalogPaths } from "./catalogPaths";
import axios from "axios";

interface createSpecInterface {
  address: string;
  port: number;
  protocol: string;
  username: string;
  password: string;
}

interface rpInterface {
  uri: string;
  insecure: boolean;
}

/**
 * GET a URL and return the response body. The client uses a self-signed
 * certificate, so certificate checks are skipped only when `insecure` is set.
 * The caller sets `insecure` to true only for 127.0.0.1.
 * @param uri {string}
 * @param insecure {boolean}
 */
async function rp({ uri, insecure }: rpInterface): Promise<any> {
  const request = await axios.get(uri, {
    httpsAgent: insecure ? new Agent({ rejectUnauthorized: false }) : undefined,
  });
  return request.data;
}

/**
 * @param address
 * @param port
 * @param username
 * @param password
 * @param protocol
 * @returns {Promise<{basePath: string, paths: {}, host: string, produces: [string, string, string], schemes: [*], definitions: {}, swagger: string, consumes, info: {description: string, title: string, version: *}}>}
 */
export default async ({
  address = "127.0.0.1",
  port,
  username = "riot",
  password,
  protocol = "https",
}: createSpecInterface): Promise<any> => {
  const insecure = address === "127.0.0.1";
  const helpConsole = await rp({
    uri: `${protocol}://${username}:${password}@${address}:${port}/help?format=Console`,
    insecure,
  });
  const helpFull = await rp({
    uri: `${protocol}://${username}:${password}@${address}:${port}/help?format=Full`,
    insecure,
  });
  const builds = await rp({
    uri: `${protocol}://${username}:${password}@${address}:${port}/system/v1/builds`,
    insecure,
  });
  const swagger = {
    host: `${address}:${port}`,
    schemes: [protocol],

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
        const fieldKey = field.name;
        swagger.definitions[type].properties[fieldKey] = {};
        swagger.definitions[type].properties[fieldKey].type = field.type.type;

        if (field.description) {
          swagger.definitions[type].properties[fieldKey].description =
            field.description;
        }

        // Check if the type of the field is an (u)int
        if (
          /^u?int/.test(swagger.definitions[type].properties[fieldKey].type)
        ) {
          swagger.definitions[type].properties[fieldKey].format =
            swagger.definitions[type].properties[fieldKey].type;
          swagger.definitions[type].properties[fieldKey].type = "integer";
          return;
        }

        // Check if the type of the field is a double
        if (swagger.definitions[type].properties[fieldKey].type === "string") {
          return;
        }

        // Check if the type of the field is a double
        if (swagger.definitions[type].properties[fieldKey].type === "double") {
          swagger.definitions[type].properties[fieldKey].format =
            swagger.definitions[type].properties[fieldKey].type;
          swagger.definitions[type].properties[fieldKey].type = "number";
          return;
        }

        // Check if the type of the field is a float
        if (swagger.definitions[type].properties[fieldKey].type === "float") {
          swagger.definitions[type].properties[fieldKey].format =
            swagger.definitions[type].properties[fieldKey].type;
          swagger.definitions[type].properties[fieldKey].type = "number";
          return;
        }

        // Check if the type of the field is signed as `object`
        if (swagger.definitions[type].properties[fieldKey].type === "object") {
          swagger.definitions[type].properties[
            fieldKey
          ].additionalProperties = true;
          return;
        }

        // Check if the type of the field is signed as `boolean`
        if (swagger.definitions[type].properties[fieldKey].type === "bool") {
          swagger.definitions[type].properties[fieldKey].type = "boolean";
          return;
        }

        if (swagger.definitions[type].properties[fieldKey].type === "map") {
          swagger.definitions[type].properties[fieldKey].type = "object";

          if (field.type.elementType === "object") {
            swagger.definitions[type].properties[
              fieldKey
            ].additionalProperties = {
              additionalProperties: true,
              type: "object",
            };
            return;
          }

          if (field.type.elementType === "string") {
            swagger.definitions[type].properties[
              fieldKey
            ].additionalProperties = {
              type: "string",
            };
            return;
          }

          if (/^u?int/.test(field.type.elementType)) {
            swagger.definitions[type].properties[
              fieldKey
            ].additionalProperties = {
              format: field.type.elementType,
              type: "integer",
            };
            return;
          }

          if (
            field.type.elementType === "double" ||
            field.type.elementType === "float"
          ) {
            swagger.definitions[type].properties[
              fieldKey
            ].additionalProperties = {
              format: field.type.elementType,
              type: "number",
            };
            return;
          }

          swagger.definitions[type].properties[
            fieldKey
          ].additionalProperties = {
            $ref: `#/definitions/${field.type.elementType}`,
          };

          return;
        }

        if (swagger.definitions[type].properties[fieldKey].type === "vector") {
          swagger.definitions[type].properties[fieldKey].type = "array";

          if (field.type.elementType === "object") {
            swagger.definitions[type].properties[fieldKey].items = {
              additionalProperties: true,
              type: "object",
            };
            return;
          }

          if (field.type.elementType === "string") {
            swagger.definitions[type].properties[fieldKey].items = {
              type: "string",
            };
            return;
          }

          if (/^u?int/.test(field.type.elementType)) {
            swagger.definitions[type].properties[fieldKey].items = {
              format: field.type.elementType,
              type: "integer",
            };
            return;
          }

          if (
            field.type.elementType === "double" ||
            field.type.elementType === "float"
          ) {
            swagger.definitions[type].properties[fieldKey].items = {
              format: field.type.elementType,
              type: "number",
            };
            return;
          }

          swagger.definitions[type].properties[fieldKey].items = {
            $ref: `#/definitions/${field.type.elementType}`,
          };

          return;
        }

        // Check if the type is an actual object
        // this is the case when a ref to another definition is made
        // if (typeof swagger.definitions[type].properties[fieldKey].type === 'object') {
        swagger.definitions[type].properties[
          fieldKey
        ].$ref = `#/definitions/${swagger.definitions[type].properties[fieldKey].type}`;
        delete swagger.definitions[type].properties[fieldKey].type;
        // }
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
