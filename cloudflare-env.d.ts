declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    APP_ORIGIN?: string;
    MODERATOR_EMAILS?: string;
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
    IMAGE_PROCESSOR_URL?: string;
    IMAGE_PROCESSOR_TOKEN?: string;
  }
}
