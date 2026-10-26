export function asDirectoryUrl(value) {
  const url = String(value || "");
  return url.endsWith("/") ? url : `${url}/`;
}
