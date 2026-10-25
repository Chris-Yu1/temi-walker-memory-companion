type RuntimeWindow = Window & {
  __env?: {
    BACKEND_URL?: string;
  };
};

export function backendOrigin(): string {
  const configured = (window as RuntimeWindow).__env?.BACKEND_URL?.trim();
  const runtimeHost = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
  const host = configured || runtimeHost;

  if (/^https?:\/\//i.test(host)) {
    const url = new URL(host);
    url.port = url.port || '3000';
    return url.origin;
  }

  return `http://${host}:3000`;
}
