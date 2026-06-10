// See https://kit.svelte.dev/docs/types#app

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    // interface Error {}
    interface Locals {
      // Set by the global CF Access gate in hooks.server.ts for non-public routes.
      cfAccess?: import('./lib/server/cf-access.ts').CfAccessIdentity;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
