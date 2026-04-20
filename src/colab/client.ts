import { UUID } from 'crypto';
import { z } from 'zod';
import { log } from '../logging/index.js';
import { uuidToWebSafeBase64 } from '../utils/uuid.js';
import {
  Assignment,
  AuthType,
  Variant,
  GetAssignmentResponse,
  AssignmentSchema,
  GetAssignmentResponseSchema,
  UserInfo,
  UserInfoSchema,
  ConsumptionUserInfo,
  ConsumptionUserInfoSchema,
  PostAssignmentResponse,
  Outcome,
  PostAssignmentResponseSchema,
  ListedAssignmentsSchema,
  ListedAssignment,
  RuntimeProxyToken,
  RuntimeProxyTokenSchema,
  Shape,
  SessionSchema,
  Session,
  CredentialsPropagationResult,
  CredentialsPropagationResultSchema,
  isHighMemOnlyAccelerator,
  Resources,
  ResourcesSchema,
} from './api.js';
import {
  ACCEPT_JSON_HEADER,
  AUTHORIZATION_HEADER,
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
  COLAB_TUNNEL_HEADER,
  COLAB_VS_CODE_APP_NAME,
  COLAB_VS_CODE_EXTENSION_VERSION,
  COLAB_XSRF_TOKEN_HEADER,
} from './headers.js';

const XSSI_PREFIX = ")]}'\n";
const TUN_ENDPOINT = '/tun/m';

interface AssignmentToken extends GetAssignmentResponse {
  kind: 'to_assign';
}

interface AssignedAssignment extends Assignment {
  kind: 'assigned';
}

interface AssignParams {
  variant: Variant;
  accelerator?: string;
  shape?: Shape;
  version?: string;
}

interface IssueRequestOptions {
  requireAccessToken?: boolean;
}

export class ColabClient {
  constructor(
    private readonly colabDomain: URL,
    private readonly colabGapiDomain: URL,
    private getAccessToken: () => Promise<string>,
    private readonly onAuthError?: () => Promise<void>,
  ) {}

  async getUserInfo(signal?: AbortSignal): Promise<UserInfo> {
    return await this.issueRequest(
      new URL('v1/user-info', this.colabGapiDomain),
      { method: 'GET', signal },
      UserInfoSchema,
    );
  }

  async getConsumptionUserInfo(signal?: AbortSignal): Promise<ConsumptionUserInfo> {
    const url = new URL('v1/user-info', this.colabGapiDomain);
    url.searchParams.set('get_ccu_consumption_info', 'true');
    return await this.issueRequest(url, { method: 'GET', signal }, ConsumptionUserInfoSchema);
  }

  async assign(
    notebookHash: UUID,
    params: AssignParams,
    signal?: AbortSignal,
  ): Promise<{ assignment: Assignment; isNew: boolean }> {
    const assignment = await this.getAssignment(notebookHash, params, signal);
    switch (assignment.kind) {
      case 'assigned': {
        const { kind: _, ...rest } = assignment;
        return { assignment: rest, isNew: false };
      }
      case 'to_assign': {
        let res: PostAssignmentResponse;
        try {
          res = await this.postAssignment(
            notebookHash,
            assignment.xsrfToken,
            params,
            signal,
          );
        } catch (error) {
          if (error instanceof ColabRequestError && error.status === 412) {
            throw new TooManyAssignmentsError(error.message);
          }
          if (error instanceof ColabRequestError && error.status === 503) {
            throw new AcceleratorUnavailableError(
              params.accelerator ?? 'default',
            );
          }
          throw error;
        }

        if (
          res.outcome === Outcome.QUOTA_DENIED_REQUESTED_VARIANTS ||
          res.outcome === Outcome.QUOTA_EXCEEDED_USAGE_TIME
        ) {
          throw new InsufficientQuotaError(
            'You have insufficient quota to assign this server.',
          );
        }
        if (res.outcome === Outcome.DENYLISTED) {
          throw new DenylistedError(
            'This account has been blocked from accessing Colab servers.',
          );
        }
        return {
          assignment: AssignmentSchema.parse(res),
          isNew: true,
        };
      }
    }
  }

  async unassign(endpoint: string, signal?: AbortSignal): Promise<void> {
    const url = new URL(`${TUN_ENDPOINT}/unassign/${endpoint}`, this.colabDomain);
    const { token } = await this.issueRequest(
      url,
      { method: 'GET', signal },
      z.object({ token: z.string() }),
    );
    await this.issueRequest(url, {
      method: 'POST',
      headers: { [COLAB_XSRF_TOKEN_HEADER.key]: token },
      signal,
    });
  }

  async refreshConnection(
    endpoint: string,
    port: number = 8080,
    signal?: AbortSignal,
  ): Promise<RuntimeProxyToken> {
    const url = new URL('v1/runtime-proxy-token', this.colabGapiDomain);
    url.searchParams.set('endpoint', endpoint);
    url.searchParams.set('port', String(port));
    return await this.issueRequest(url, { method: 'GET', signal }, RuntimeProxyTokenSchema);
  }

  async listAssignments(signal?: AbortSignal): Promise<ListedAssignment[]> {
    const response = await this.issueRequest(
      new URL('v1/assignments', this.colabGapiDomain),
      { method: 'GET', signal },
      ListedAssignmentsSchema,
    );
    return response.assignments;
  }

  async listSessions(endpoint: string, signal?: AbortSignal): Promise<Session[]> {
    const url = new URL(`${TUN_ENDPOINT}/${endpoint}/api/sessions`, this.colabDomain);
    const headers = { [COLAB_TUNNEL_HEADER.key]: COLAB_TUNNEL_HEADER.value };
    return await this.issueRequest(
      url,
      { method: 'GET', headers, signal },
      z.array(SessionSchema),
    );
  }

  async propagateCredentials(
    endpoint: string,
    params: { authType: AuthType; dryRun: boolean },
    signal?: AbortSignal,
  ): Promise<CredentialsPropagationResult> {
    const url = new URL(`${TUN_ENDPOINT}/credentials-propagation/${endpoint}`, this.colabDomain);
    url.searchParams.set('authtype', params.authType);
    url.searchParams.set('version', '2');
    url.searchParams.set('dryrun', String(params.dryRun));
    url.searchParams.set('propagate', 'true');
    url.searchParams.set('record', 'false');

    const { token } = await this.issueRequest(
      url,
      { method: 'GET', signal },
      z.object({ token: z.string() }),
    );

    return await this.issueRequest(
      url,
      {
        method: 'POST',
        headers: { [COLAB_XSRF_TOKEN_HEADER.key]: token },
        signal,
      },
      CredentialsPropagationResultSchema,
    );
  }

  /**
   * Gets the resources (RAM, disk, GPU) for a given runtime.
   *
   * @param proxyUrl - The runtime proxy base URL.
   * @param token - The runtime proxy token.
   * @param signal - Optional {@link AbortSignal} to cancel the request.
   * @returns The resources information.
   */
  async getResources(
    proxyUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<Resources> {
    const url = new URL('api/colab/resources', proxyUrl);
    const headers = {
      [COLAB_RUNTIME_PROXY_TOKEN_HEADER.key]: token,
    };

    return await this.issueRequest(
      url,
      { method: 'GET', headers, signal },
      ResourcesSchema,
    );
  }

  async getRuntimeVersions(signal?: AbortSignal): Promise<string[]> {
    const url = new URL('vscode/experiment-state', this.colabDomain);
    const ExperimentStateSchema = z.object({
      experiments: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional())
        .optional(),
    });
    const result = await this.issueRequest(
      url,
      { method: 'GET', signal },
      ExperimentStateSchema,
      { requireAccessToken: false },
    );
    const versions = result.experiments?.['runtime_version_names'];
    if (Array.isArray(versions) && versions.every((v) => typeof v === 'string')) {
      return versions as string[];
    }
    return [];
  }

  async sendKeepAlive(endpoint: string, signal?: AbortSignal): Promise<void> {
    await this.issueRequest(
      new URL(`${TUN_ENDPOINT}/${endpoint}/keep-alive/`, this.colabDomain),
      {
        method: 'GET',
        headers: { [COLAB_TUNNEL_HEADER.key]: COLAB_TUNNEL_HEADER.value },
        signal,
      },
    );
  }

  private async getAssignment(
    notebookHash: UUID,
    params: AssignParams,
    signal?: AbortSignal,
  ): Promise<AssignmentToken | AssignedAssignment> {
    const url = this.buildAssignUrl(notebookHash, params);
    const response = await this.issueRequest(
      url,
      { method: 'GET', signal },
      z.union([GetAssignmentResponseSchema, AssignmentSchema]),
    );
    if ('xsrfToken' in response) {
      return { ...response, kind: 'to_assign' };
    } else {
      return { ...response, kind: 'assigned' };
    }
  }

  private async postAssignment(
    notebookHash: UUID,
    xsrfToken: string,
    params: AssignParams,
    signal?: AbortSignal,
  ): Promise<PostAssignmentResponse> {
    const url = this.buildAssignUrl(notebookHash, params);
    return await this.issueRequest(
      url,
      {
        method: 'POST',
        headers: { [COLAB_XSRF_TOKEN_HEADER.key]: xsrfToken },
        signal,
      },
      PostAssignmentResponseSchema,
    );
  }

  private buildAssignUrl(
    notebookHash: UUID,
    { variant, accelerator, shape, version }: AssignParams,
  ): URL {
    const url = new URL(`${TUN_ENDPOINT}/assign`, this.colabDomain);
    url.searchParams.set('nbh', uuidToWebSafeBase64(notebookHash));
    if (variant !== Variant.DEFAULT) {
      url.searchParams.set('variant', variant);
    }
    if (accelerator) {
      url.searchParams.set('accelerator', accelerator);
    }
    const shapeURLParam = mapShapeToURLParam(
      isHighMemOnlyAccelerator(accelerator)
        ? Shape.STANDARD
        : (shape ?? Shape.STANDARD),
    );
    if (shapeURLParam) {
      url.searchParams.set('shape', shapeURLParam);
    }
    if (version) {
      url.searchParams.set('runtime_version_label', version);
    }
    return url;
  }

  private async issueRequest<T extends z.ZodType>(
    endpoint: URL,
    init: RequestInit,
    schema: T,
    options?: IssueRequestOptions,
  ): Promise<z.infer<T>>;

  private async issueRequest(endpoint: URL, init: RequestInit): Promise<void>;

  private async issueRequest(
    endpoint: URL,
    init: RequestInit,
    schema?: z.ZodType,
    { requireAccessToken = true }: IssueRequestOptions = {},
  ): Promise<unknown> {
    if (endpoint.hostname === this.colabDomain.hostname) {
      endpoint.searchParams.set('authuser', '0');
    }

    let response: Response | undefined;
    const requestHeaders = new Headers(init.headers as HeadersInit);
    requestHeaders.set('User-Agent', 'node');
    requestHeaders.set(ACCEPT_JSON_HEADER.key, ACCEPT_JSON_HEADER.value);
    requestHeaders.set(COLAB_CLIENT_AGENT_HEADER.key, COLAB_CLIENT_AGENT_HEADER.value);
    requestHeaders.set(COLAB_VS_CODE_APP_NAME.key, COLAB_VS_CODE_APP_NAME.value);
    requestHeaders.set(COLAB_VS_CODE_EXTENSION_VERSION.key, COLAB_VS_CODE_EXTENSION_VERSION.value);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (requireAccessToken) {
        const token = await this.getAccessToken();
        requestHeaders.set(AUTHORIZATION_HEADER.key, `Bearer ${token}`);
      }

      response = await fetch(endpoint.toString(), {
        ...init,
        headers: requestHeaders,
      });
      if (response.ok) {
        break;
      }

      if (response.status === 401 && this.onAuthError && attempt < 1) {
        await this.onAuthError();
      } else {
        break;
      }
    }

    if (!response) {
      return;
    }

    if (!response.ok) {
      let errorBody: string | undefined;
      try {
        errorBody = await response.text();
      } catch {
        // Ignore errors reading the body
      }
      throw new ColabRequestError(
        `Failed to issue request ${init.method} ${endpoint.toString()}: ${response.statusText}` +
          (errorBody ? `\nResponse body: ${errorBody}` : ''),
        response.status,
      );
    }

    if (!schema) {
      return;
    }

    const body = await response.text();
    return schema.parse(JSON.parse(stripXssiPrefix(body)));
  }
}

export class TooManyAssignmentsError extends Error {}

/** Error thrown when the requested machine accelerator is unavailable. */
export class AcceleratorUnavailableError extends Error {
  constructor(readonly requested: string) {
    super(`Requested accelerator "${requested}" is unavailable`);
  }
}

export class DenylistedError extends Error {}
export class InsufficientQuotaError extends Error {}
export class NotFoundError extends Error {}

export class ColabRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function stripXssiPrefix(v: string): string {
  if (!v.startsWith(XSSI_PREFIX)) {
    return v;
  }
  return v.slice(XSSI_PREFIX.length);
}

function mapShapeToURLParam(shape: Shape): string | undefined {
  switch (shape) {
    case Shape.HIGHMEM:
      return 'hm';
    default:
      return undefined;
  }
}
