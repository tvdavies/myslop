/// <reference path="../node_modules/@cloudflare/workers-types/index.d.ts" />

declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}
