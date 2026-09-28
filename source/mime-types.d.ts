/**
 * The shape of the `mime-types` module the host uses: it looks a path up and answers with a type, or with false when
 * it does not know one.
 */
declare module "mime-types" {
  const mimeTypes: {
    lookup(path: string): string | false;
  };
  export default mimeTypes;
}
