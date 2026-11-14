/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_KEY?: string;
  readonly VITE_SUPPORT_EMAIL?: string;
  readonly VITE_IMPRESSUM_NAME?: string;
  readonly VITE_IMPRESSUM_ANSCHRIFT?: string;
  readonly VITE_IMPRESSUM_GEWERBE?: string;
  readonly VITE_IMPRESSUM_BEHOERDE?: string;
  readonly VITE_IMPRESSUM_KAMMER?: string;
  readonly VITE_IMPRESSUM_UID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
