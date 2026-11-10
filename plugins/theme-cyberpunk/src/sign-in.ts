import * as client from "@capybara-hq/plugin-client";

/**
 * The viewer's sign-in id (`useSignIn().id`: the same for one sign-in, new after the next), or
 * null where the host predates `useSignIn`. plugin-client 0.1.0-rc.1 has no `useSignIn`, and a
 * named import of a name the host does not export would fail the whole module, so it is read off
 * the namespace. Whether the hook exists is fixed for the document, so the hook order is stable.
 * Once the plugin-client release with `useSignIn` is the dependency, this becomes
 * `return useSignIn().id;`.
 */
export function useSignInId(): string | null {
  const useSignIn = (client as { useSignIn?: () => { id: string } }).useSignIn;
  if (useSignIn === undefined) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: whether the host exports it is fixed per document
  return useSignIn().id;
}
