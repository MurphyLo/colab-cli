import { z } from 'zod';

export enum SubscriptionState {
  UNSUBSCRIBED = 1,
  RECURRING = 2,
  NON_RECURRING = 3,
  PENDING_ACTIVATION = 4,
  DECLINED = 5,
}

export enum SubscriptionTier {
  NONE = 0,
  PRO = 1,
  PRO_PLUS = 2,
}

enum ColabSubscriptionTier {
  UNKNOWN = 0,
  PRO = 1,
  VERY_PRO = 2,
}

const COLAB_GAPI_SUB_TIERS = [
  'SUBSCRIPTION_TIER_UNSPECIFIED',
  'SUBSCRIPTION_TIER_NONE',
  'SUBSCRIPTION_TIER_PRO',
  'SUBSCRIPTION_TIER_PRO_PLUS',
] as const;
type ColabGapiSubscriptionTier = (typeof COLAB_GAPI_SUB_TIERS)[number];

export enum Outcome {
  UNDEFINED_OUTCOME = 0,
  QUOTA_DENIED_REQUESTED_VARIANTS = 1,
  QUOTA_EXCEEDED_USAGE_TIME = 2,
  SUCCESS = 4,
  DENYLISTED = 5,
}

export enum Variant {
  DEFAULT = 'DEFAULT',
  GPU = 'GPU',
  TPU = 'TPU',
}
const VARIANTS = ['DEFAULT', 'GPU', 'TPU'] as const;

const COLAB_GAPI_VARIANTS = [
  'VARIANT_UNSPECIFIED',
  'VARIANT_GPU',
  'VARIANT_TPU',
] as const;
type ColabGapiVariant = (typeof COLAB_GAPI_VARIANTS)[number];

export enum Shape {
  STANDARD = 0,
  HIGHMEM = 1,
}

const COLAB_GAPI_SHAPES = [
  'SHAPE_UNSPECIFIED',
  'SHAPE_DEFAULT',
  'SHAPE_HIGH_MEM',
] as const;
type ColabGapiShape = (typeof COLAB_GAPI_SHAPES)[number];

export enum AuthType {
  DFS_EPHEMERAL = 'dfs_ephemeral',
  AUTH_USER_EPHEMERAL = 'auth_user_ephemeral',
}
export const AUTH_TYPE_VALUES = ['dfs_ephemeral', 'auth_user_ephemeral'] as const;

function normalizeSubTier(
  tier: ColabSubscriptionTier | ColabGapiSubscriptionTier,
): SubscriptionTier {
  switch (tier) {
    case ColabSubscriptionTier.PRO:
    case 'SUBSCRIPTION_TIER_PRO':
      return SubscriptionTier.PRO;
    case ColabSubscriptionTier.VERY_PRO:
    case 'SUBSCRIPTION_TIER_PRO_PLUS':
      return SubscriptionTier.PRO_PLUS;
    default:
      return SubscriptionTier.NONE;
  }
}

function normalizeGapiSubTier(tier: ColabGapiSubscriptionTier): SubscriptionTier {
  return normalizeSubTier(tier);
}

function normalizeVariant(variant: ColabGapiVariant): Variant {
  switch (variant) {
    case 'VARIANT_GPU': return Variant.GPU;
    case 'VARIANT_TPU': return Variant.TPU;
    case 'VARIANT_UNSPECIFIED': return Variant.DEFAULT;
  }
}

function normalizeShape(shape: ColabGapiShape): Shape {
  switch (shape) {
    case 'SHAPE_HIGH_MEM': return Shape.HIGHMEM;
    default: return Shape.STANDARD;
  }
}

export const Accelerator = z.object({
  variant: z.enum(COLAB_GAPI_VARIANTS).transform(normalizeVariant),
  models: z
    .array(z.string().toUpperCase())
    .optional()
    .transform((models) => models ?? []),
});

export const UserInfoSchema = z.object({
  subscriptionTier: z
    .enum(COLAB_GAPI_SUB_TIERS)
    .transform(normalizeGapiSubTier),
  paidComputeUnitsBalance: z.number().optional(),
  eligibleAccelerators: z.array(Accelerator),
  ineligibleAccelerators: z.array(Accelerator),
});
export type UserInfo = z.infer<typeof UserInfoSchema>;

export const ConsumptionUserInfoSchema = UserInfoSchema.required({
  paidComputeUnitsBalance: true,
}).extend({
  consumptionRateHourly: z.number(),
  assignmentsCount: z.number(),
  freeCcuQuotaInfo: z
    .object({
      // Is only defined when there is no paid CCU balance remaining.
      remainingTokens: z
        .string()
        .optional()
        .refine(
          (val) => {
            if (val === undefined) return true;
            return Number.isSafeInteger(Number(val));
          },
          { message: 'Value too large to be a safe integer for JavaScript' },
        )
        .transform((val) => (val !== undefined ? Number(val) : undefined)),
      nextRefillTimestampSec: z.number().optional(),
    })
    .optional(),
});
export type ConsumptionUserInfo = z.infer<typeof ConsumptionUserInfoSchema>;

export const GetAssignmentResponseSchema = z
  .object({
    acc: z.string().toUpperCase(),
    nbh: z.string(),
    p: z.boolean(),
    token: z.string(),
    variant: z.enum(VARIANTS),
  })
  .transform(({ acc, nbh, p, token, ...rest }) => ({
    ...rest,
    accelerator: acc,
    notebookIdHash: nbh,
    shouldPromptRecaptcha: p,
    xsrfToken: token,
  }));
export type GetAssignmentResponse = z.infer<typeof GetAssignmentResponseSchema>;

export const RuntimeProxyInfoSchema = z.object({
  token: z.string(),
  tokenExpiresInSeconds: z.number(),
  url: z.string(),
});

const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export const RuntimeProxyTokenSchema = z
  .object({
    token: z.string(),
    tokenTtl: z.string(),
    url: z.string(),
  })
  .transform(({ tokenTtl, ...rest }) => {
    const tokenExpiresInSeconds = Number(tokenTtl.slice(0, -1));
    return {
      ...rest,
      tokenExpiresInSeconds:
        Number.isNaN(tokenExpiresInSeconds) || tokenExpiresInSeconds <= 0
          ? DEFAULT_TOKEN_TTL_SECONDS
          : tokenExpiresInSeconds,
    };
  });
export type RuntimeProxyToken = z.infer<typeof RuntimeProxyTokenSchema>;

export const PostAssignmentResponseSchema = z.object({
  accelerator: z.string().toUpperCase().optional(),
  endpoint: z.string().optional(),
  fit: z.number().optional(),
  allowedCredentials: z.boolean().optional(),
  sub: z.nativeEnum(SubscriptionState).optional(),
  subTier: z.nativeEnum(ColabSubscriptionTier).transform(normalizeSubTier).optional(),
  outcome: z.nativeEnum(Outcome).optional(),
  variant: z.preprocess((val) => {
    if (typeof val === 'number') {
      switch (val) {
        case 0: return Variant.DEFAULT;
        case 1: return Variant.GPU;
        case 2: return Variant.TPU;
      }
    }
    return val;
  }, z.enum(VARIANTS).optional()),
  machineShape: z.nativeEnum(Shape).optional(),
  runtimeProxyInfo: RuntimeProxyInfoSchema.optional(),
});
export type PostAssignmentResponse = z.infer<typeof PostAssignmentResponseSchema>;

export const ListedAssignmentSchema = z.object({
  endpoint: z.string(),
  accelerator: z.string().toUpperCase(),
  variant: z.enum(COLAB_GAPI_VARIANTS).transform(normalizeVariant),
  machineShape: z.enum(COLAB_GAPI_SHAPES).transform(normalizeShape),
  runtimeProxyInfo: RuntimeProxyTokenSchema.optional(),
});
export type ListedAssignment = z.infer<typeof ListedAssignmentSchema>;

export const ListedAssignmentsSchema = z.object({
  assignments: z
    .array(ListedAssignmentSchema)
    .optional()
    .transform((assignments) => assignments ?? []),
});
export type ListedAssignments = z.infer<typeof ListedAssignmentsSchema>;

export const AssignmentSchema = PostAssignmentResponseSchema.omit({
  outcome: true,
})
  .required({
    accelerator: true,
    endpoint: true,
    variant: true,
    machineShape: true,
    runtimeProxyInfo: true,
  })
  .transform(({ fit, sub, subTier, ...rest }) => ({
    ...rest,
    idleTimeoutSec: fit,
    subscriptionState: sub,
    subscriptionTier: subTier,
  }));
export type Assignment = z.infer<typeof AssignmentSchema>;

export const KernelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    last_activity: z.string(),
    execution_state: z.string(),
    connections: z.number(),
  })
  .transform(({ last_activity, execution_state, ...rest }) => ({
    ...rest,
    lastActivity: last_activity,
    executionState: execution_state,
  }));
export type Kernel = z.infer<typeof KernelSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  kernel: KernelSchema,
  name: z.string(),
  path: z.string(),
  type: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CredentialsPropagationResultSchema = z
  .object({
    success: z.boolean(),
    unauthorized_redirect_uri: z.string().optional(),
  })
  .transform(({ unauthorized_redirect_uri, ...rest }) => ({
    ...rest,
    unauthorizedRedirectUri: unauthorized_redirect_uri,
  }));
export type CredentialsPropagationResult = z.infer<typeof CredentialsPropagationResultSchema>;

/** Information about memory usage on a Colab runtime. */
export const MemorySchema = z
  .object({
    totalBytes: z.number().optional(),
    freeBytes: z.number().optional(),
  })
  .transform(({ totalBytes, freeBytes }) => ({
    totalBytes: totalBytes ?? 0,
    freeBytes: freeBytes ?? 0,
  }));
export type Memory = z.infer<typeof MemorySchema>;

/** Information about a GPU on a Colab runtime. */
export const GpuInfoSchema = z
  .object({
    name: z.string().optional(),
    memoryUsedBytes: z.number().optional(),
    memoryTotalBytes: z.number().optional(),
    gpuUtilization: z.number().optional(),
    memoryUtilization: z.number().optional(),
    everUsed: z.boolean().optional(),
  })
  .transform(({ memoryUsedBytes, memoryTotalBytes, ...rest }) => ({
    ...rest,
    memoryUsedBytes: memoryUsedBytes ?? 0,
    memoryTotalBytes: memoryTotalBytes ?? 0,
  }));
export type GpuInfo = z.infer<typeof GpuInfoSchema>;

/** Information about a filesystem on a Colab runtime. */
export const FilesystemSchema = z
  .object({
    label: z.string().optional(),
    totalBytes: z.number().optional(),
    usedBytes: z.number().optional(),
  })
  .transform(({ totalBytes, usedBytes, ...rest }) => ({
    ...rest,
    totalBytes: totalBytes ?? 0,
    usedBytes: usedBytes ?? 0,
  }));
export type Filesystem = z.infer<typeof FilesystemSchema>;

/** Information about a disk on a Colab runtime. */
export const DiskSchema = z.object({
  filesystem: FilesystemSchema.optional().transform(
    (filesystem) => filesystem ?? { totalBytes: 0, usedBytes: 0 },
  ),
});
export type Disk = z.infer<typeof DiskSchema>;

/** The schema for resources (RAM, disk, GPU) on a Colab runtime. */
export const ResourcesSchema = z.object({
  memory: MemorySchema.optional().transform(
    (memory) => memory ?? { totalBytes: 0, freeBytes: 0 },
  ),
  disks: z.array(DiskSchema),
  gpus: z
    .array(GpuInfoSchema)
    .optional()
    .transform((val) => val ?? []),
});
export type Resources = z.infer<typeof ResourcesSchema>;

export function variantToMachineType(variant: Variant): string {
  switch (variant) {
    case Variant.DEFAULT: return 'CPU';
    case Variant.GPU: return 'GPU';
    case Variant.TPU: return 'TPU';
  }
}

export function shapeToMachineShape(shape: Shape): string {
  switch (shape) {
    case Shape.HIGHMEM: return 'High-RAM';
    case Shape.STANDARD:
    default: return 'Standard';
  }
}

const HIGHMEM_ONLY_ACCELERATORS = new Set([
  'H100',
  'G4',
  'L4',
  'V28',
  'V5E1',
  'V6E1',
]);

export function isHighMemOnlyAccelerator(accelerator?: string): boolean {
  return accelerator !== undefined && HIGHMEM_ONLY_ACCELERATORS.has(accelerator);
}
