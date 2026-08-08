declare global {
  interface URLPatternInit {
    baseURL?: string;
    username?: string;
    password?: string;
    protocol?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    search?: string;
    hash?: string;
  }

  type URLPatternInput = URLPatternInit | string;

  interface URLPatternOptions {
    ignoreCase?: boolean;
  }

  class URLPattern {
    constructor(input?: URLPatternInput, baseURL?: string | URL, options?: URLPatternOptions);
  }
}

export {};
