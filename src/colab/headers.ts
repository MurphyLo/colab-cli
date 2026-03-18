export interface Header {
  readonly key: string;
}

export interface StaticHeader extends Header {
  readonly value: string;
}

export const CONTENT_TYPE_JSON_HEADER: StaticHeader = {
  key: 'Content-Type',
  value: 'application/json',
};

export const ACCEPT_JSON_HEADER: StaticHeader = {
  key: 'Accept',
  value: 'application/json',
};

export const COLAB_CLIENT_AGENT_HEADER: StaticHeader = {
  key: 'X-Colab-Client-Agent',
  value: 'vscode',
};

export const COLAB_VS_CODE_APP_NAME: StaticHeader = {
  key: 'X-Colab-VS-Code-App-Name',
  value: 'Visual Studio Code',
};

export const COLAB_VS_CODE_EXTENSION_VERSION: StaticHeader = {
  key: 'X-Colab-VS-Code-Extension-Version',
  value: '0.4.1',
};

export const COLAB_TUNNEL_HEADER: StaticHeader = {
  key: 'X-Colab-Tunnel',
  value: 'Google',
};

export const AUTHORIZATION_HEADER: Header = {
  key: 'Authorization',
};

export const COLAB_RUNTIME_PROXY_TOKEN_HEADER: Header = {
  key: 'X-Colab-Runtime-Proxy-Token',
};

export const COLAB_XSRF_TOKEN_HEADER: Header = {
  key: 'X-Goog-Colab-Token',
};
