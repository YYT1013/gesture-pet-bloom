export function shouldTrackTouch(previousContact, contact) {
  return !previousContact && Boolean(contact);
}
