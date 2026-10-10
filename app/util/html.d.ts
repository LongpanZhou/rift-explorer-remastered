/** Lets a `.html` file be imported as its text, with `with { type: "text" }`. */
declare module "*.html" {
  const content: string;
  export default content;
}
