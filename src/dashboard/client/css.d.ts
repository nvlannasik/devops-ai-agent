// esbuild turns a CSS import into a sibling stylesheet; TypeScript has no idea what a .css
// module is and rejects the side-effect import without this. Declaration only — there is no
// value to import, which is why the module body is empty.
declare module "*.css";
