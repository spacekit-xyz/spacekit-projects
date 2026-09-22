/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_USE_MESSAGING_PROXY?: string;
  readonly VITE_SPACEKIT_MESSAGING_NODE_URL?: string;
  readonly VITE_SPACETIME_MESSAGING_URL?: string;
  readonly VITE_SPACEKIT_STORAGE_NODE_URL?: string;
  readonly VITE_SPACEKIT_STORAGE_NODE_RPC?: string;
  readonly VITE_SOCIAL_API_URL?: string;
  readonly VITE_SOCIAL_USE_LOCAL_API?: string;
  readonly VITE_PRODUCTION_API_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_USE_ANVIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
