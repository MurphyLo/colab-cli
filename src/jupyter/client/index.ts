import {
  COLAB_CLIENT_AGENT_HEADER,
  COLAB_RUNTIME_PROXY_TOKEN_HEADER,
} from '../../colab/headers.js';
import {
  Configuration,
  KernelsApi,
  SessionsApi,
  Middleware,
  type FetchParams,
  type RequestContext,
} from './generated/index.js';

export class ProxiedJupyterClient {
  private kernelsApi: KernelsApi | undefined;
  private sessionsApi: SessionsApi | undefined;
  private clientConfig: Configuration;

  constructor(
    basePath: string,
    private readonly getProxyToken: () => Promise<string>,
  ) {
    this.clientConfig = new Configuration({
      basePath,
      headers: {
        [COLAB_CLIENT_AGENT_HEADER.key]: COLAB_CLIENT_AGENT_HEADER.value,
      },
      middleware: [new AddProxyToken(getProxyToken)],
    });
  }

  get kernels(): KernelsApi {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.kernelsApi ??= new (KernelsApi as any)(this.clientConfig));
  }

  get sessions(): SessionsApi {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.sessionsApi ??= new (SessionsApi as any)(this.clientConfig));
  }
}

class AddProxyToken implements Middleware {
  constructor(private readonly getToken: () => Promise<string>) {}

  async pre(context: RequestContext): Promise<FetchParams> {
    const h = new Headers(context.init.headers as HeadersInit);
    const t = await this.getToken();
    h.set(COLAB_RUNTIME_PROXY_TOKEN_HEADER.key, t);
    context.init.headers = h;
    return context;
  }
}
