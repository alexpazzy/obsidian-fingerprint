// The helper sources are bundled into main.js as text (esbuild's text loader)
// so the plugin can materialize them even when installed from the community
// directory, which only delivers main.js, manifest.json and styles.css.
declare module "*.swift" {
	const contents: string;
	export default contents;
}

declare module "*.ps1" {
	const contents: string;
	export default contents;
}
