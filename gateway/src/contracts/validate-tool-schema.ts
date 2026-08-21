import Ajv2020 from "ajv/dist/2020.js";

export const INVALID_TOOL_INPUT_SCHEMA = "invalid-tool-input-schema" as const;

interface ToolSchemaGroup {
  readonly id: string;
  readonly tools: readonly {
    readonly name: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
}

export class InvalidToolInputSchemaError extends Error {
  readonly code = INVALID_TOOL_INPUT_SCHEMA;

  constructor(
    readonly domain: string,
    readonly tool: string,
  ) {
    super(INVALID_TOOL_INPUT_SCHEMA);
    this.name = "InvalidToolInputSchemaError";
  }
}

export function invalidToolInputSchemaDetails(
  error: InvalidToolInputSchemaError,
): Readonly<{ code: typeof INVALID_TOOL_INPUT_SCHEMA; domain: string; tool: string }> {
  return { code: error.code, domain: error.domain, tool: error.tool };
}

export function assertToolInputSchemas(groups: readonly ToolSchemaGroup[]): void {
  for (const group of groups) {
    for (const tool of group.tools) {
      if (tool.inputSchema.type !== "object") {
        throw new InvalidToolInputSchemaError(group.id, tool.name);
      }

      try {
        new Ajv2020({ strict: true, validateFormats: false }).compile(tool.inputSchema);
      } catch {
        throw new InvalidToolInputSchemaError(group.id, tool.name);
      }
    }
  }
}
