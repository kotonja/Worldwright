import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { diagnostic, sortDiagnostics, type RobloxDiagnostic } from './diagnostics.js';
import {
  RobloxContainerDirectiveSchema,
  RobloxCornerWedgeDirectiveSchema,
  RobloxDirectiveSchema,
  RobloxPartDirectiveSchema,
  RobloxWedgeDirectiveSchema,
  type RobloxDirective,
} from './directive-schema.js';
import { appendPointer, compareCodePoints, inspectJsonCompatibility } from './json.js';

export type RobloxDirectiveValidationResult =
  | {
      readonly valid: true;
      readonly value: RobloxDirective;
      readonly diagnostics: readonly [];
    }
  | {
      readonly valid: false;
      readonly diagnostics: readonly RobloxDiagnostic[];
    };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
  validateFormats: false,
});

const checkDirectiveSchema = ajv.compile<RobloxDirective>(RobloxDirectiveSchema);
const checkContainerDirective = ajv.compile(RobloxContainerDirectiveSchema);
const checkPartDirective = ajv.compile(RobloxPartDirectiveSchema);
const checkWedgeDirective = ajv.compile(RobloxWedgeDirectiveSchema);
const checkCornerWedgeDirective = ajv.compile(RobloxCornerWedgeDirectiveSchema);

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function branchValidator(
  input: Readonly<Record<string, unknown>>,
):
  | { readonly validator: ValidateFunction }
  | { readonly path: '/mode' | '/className'; readonly message: string } {
  if (input.mode !== 'container' && input.mode !== 'primitive') {
    return {
      path: '/mode',
      message:
        input.mode === undefined
          ? 'Required Roblox directive property is missing.'
          : 'Roblox directive value is not an allowed choice.',
    };
  }

  if (input.mode === 'container') {
    if (input.className !== 'Folder' && input.className !== 'Model') {
      return {
        path: '/className',
        message:
          input.className === undefined
            ? 'Required Roblox directive property is missing.'
            : 'Roblox directive value is not an allowed choice.',
      };
    }
    return { validator: checkContainerDirective };
  }

  switch (input.className) {
    case 'Part':
      return { validator: checkPartDirective };
    case 'WedgePart':
      return { validator: checkWedgeDirective };
    case 'CornerWedgePart':
      return { validator: checkCornerWedgeDirective };
    default:
      return {
        path: '/className',
        message:
          input.className === undefined
            ? 'Required Roblox directive property is missing.'
            : 'Roblox directive value is not an allowed choice.',
      };
  }
}

function normalizeDirective(input: Readonly<RobloxDirective>): RobloxDirective {
  if (input.mode === 'container') {
    return {
      schemaVersion: input.schemaVersion,
      mode: 'container',
      className: input.className,
    };
  }

  const primitive = {
    schemaVersion: input.schemaVersion,
    mode: 'primitive' as const,
    material: input.material,
    color: { r: input.color.r, g: input.color.g, b: input.color.b },
    transparency: Object.is(input.transparency, -0) ? 0 : input.transparency,
    canCollide: input.canCollide,
    canQuery: input.canQuery,
    canTouch: input.canTouch,
    castShadow: input.castShadow,
  };

  switch (input.className) {
    case 'Part':
      return { ...primitive, className: 'Part', shape: input.shape };
    case 'WedgePart':
      return { ...primitive, className: 'WedgePart' };
    case 'CornerWedgePart':
      return { ...primitive, className: 'CornerWedgePart' };
  }
}

function parameter(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function errorPath(error: ErrorObject): string {
  const property =
    error.keyword === 'required'
      ? parameter(error, 'missingProperty')
      : error.keyword === 'additionalProperties'
        ? parameter(error, 'additionalProperty')
        : undefined;
  return property === undefined ? error.instancePath : appendPointer(error.instancePath, property);
}

function errorMessage(error: ErrorObject): string {
  switch (error.keyword) {
    case 'additionalProperties':
      return 'Property is not allowed by the Roblox directive contract.';
    case 'required':
      return 'Required Roblox directive property is missing.';
    case 'type':
      return 'Roblox directive value has the wrong type.';
    case 'const':
    case 'enum':
      return 'Roblox directive value is not an allowed choice.';
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return 'Roblox directive number is outside the allowed range.';
    default:
      return 'Value does not satisfy the Roblox directive contract.';
  }
}

function errorPriority(error: ErrorObject): number {
  switch (error.keyword) {
    case 'additionalProperties':
      return 0;
    case 'required':
      return 1;
    case 'type':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return 2;
    case 'const':
    case 'enum':
      return 3;
    default:
      return 4;
  }
}

function mostUsefulSchemaError(
  errors: readonly ErrorObject[] | null | undefined,
): ErrorObject | undefined {
  return [...(errors ?? [])].sort((left, right) => {
    const byPriority = errorPriority(left) - errorPriority(right);
    if (byPriority !== 0) return byPriority;
    const byPath = compareCodePoints(errorPath(left), errorPath(right));
    if (byPath !== 0) return byPath;
    return compareCodePoints(left.keyword, right.keyword);
  })[0];
}

/** Validates one in-memory directive without throwing for expected invalid data. */
export function validateRobloxDirective(
  input: unknown,
  basePath = '',
): RobloxDirectiveValidationResult {
  try {
    const issue = inspectJsonCompatibility(input);
    if (issue !== undefined) {
      return {
        valid: false,
        diagnostics: [
          diagnostic(
            'compiler.directive_invalid',
            `${basePath}${issue.path}`,
            `Roblox directive is not JSON-compatible: ${issue.reason}.`,
          ),
        ],
      };
    }

    const record = objectRecord(input);
    const branch = record === undefined ? undefined : branchValidator(record);
    if (branch !== undefined && 'path' in branch) {
      return {
        valid: false,
        diagnostics: [
          diagnostic('compiler.directive_invalid', `${basePath}${branch.path}`, branch.message),
        ],
      };
    }

    const selectedValidator = branch?.validator ?? checkDirectiveSchema;
    if (!selectedValidator(input)) {
      const schemaError = mostUsefulSchemaError(selectedValidator.errors);
      return {
        valid: false,
        diagnostics: sortDiagnostics([
          diagnostic(
            'compiler.directive_invalid',
            `${basePath}${schemaError === undefined ? '' : errorPath(schemaError)}`,
            schemaError === undefined
              ? 'Value does not satisfy the Roblox directive contract.'
              : errorMessage(schemaError),
          ),
        ]),
      };
    }

    // The selected branch is a subset of the public union and this call narrows the static type.
    if (!checkDirectiveSchema(input)) {
      return {
        valid: false,
        diagnostics: [
          diagnostic(
            'compiler.directive_invalid',
            basePath,
            'Value does not satisfy the Roblox directive contract.',
          ),
        ],
      };
    }

    return { valid: true, value: normalizeDirective(input), diagnostics: [] };
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          'compiler.directive_invalid',
          basePath,
          'Roblox directive could not be safely inspected.',
        ),
      ],
    };
  }
}
