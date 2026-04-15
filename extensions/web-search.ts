/**
 * Web Search Extension - DuckDuckGo Search Tool
 *
 * Provides a web_search tool that uses DuckDuckGo to search the web.
 * No API key required - uses DuckDuckGo's free search endpoint.
 *
 * Usage:
 *   The LLM can call web_search with a query to get search results.
 *   Results include titles, URLs, and snippets.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Interface for search results
interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Search DuckDuckGo and return results
 * Uses the HTML endpoint and parses results
 */
async function searchDuckDuckGo(query: string, maxResults: number = 5): Promise<SearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.5",
			"Accept-Encoding": "gzip, deflate",
		},
	});

	if (!response.ok) {
		throw new Error(`Search failed: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	return parseSearchResults(html, maxResults);
}

/**
 * Parse HTML to extract search results
 */
function parseSearchResults(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];

	// DuckDuckGo HTML results are in .result elements
	// Each result has:
	// - .result__a - title and link
	// - .result__snippet - snippet/description
	// - .result__url - URL display

	const resultRegex = /<div class="result[^"]*"[^>]*>.*?<\/div>\s*<\/div>\s*<\/div>/gs;
	const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is;
	const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/is;
	const urlRegex = /<a[^>]*class="result__url"[^>]*href="[^"]*"[^>]*>(.*?)<\/a>/is;

	const resultBlocks = html.match(resultRegex) || [];

	for (const block of resultBlocks.slice(0, maxResults)) {
		const linkMatch = block.match(linkRegex);
		const snippetMatch = block.match(snippetRegex);
		const urlMatch = block.match(urlRegex);

		if (linkMatch) {
			const title = stripHtml(linkMatch[2]);
			const href = linkMatch[1];
			const url = decodeURIComponent(href.replace(/^\/l\?i\.([^&]+).*$/, "$1").replace(/^\/l\?uddg=([^&]+).*$/, "$1"));
			const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

			if (title && url) {
				results.push({
					title: title.trim(),
					url: url.trim(),
					snippet: snippet.trim(),
				});
			}
		}
	}

	return results;
}

/**
 * Strip HTML tags from text
 */
function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Alternative search using DuckDuckGo's Lite format (more stable)
 */
async function searchDuckDuckGoLite(query: string, maxResults: number = 5): Promise<SearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const url = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}&kl=us-en`;

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.5",
		},
	});

	if (!response.ok) {
		throw new Error(`Search failed: ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	return parseLiteResults(html, maxResults);
}

/**
 * Parse DuckDuckGo Lite HTML results
 */
function parseLiteResults(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];

	// DuckDuckGo Lite uses different class names in a table format
	// Results are in .result-link and .result-snippet
	const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gim;
	const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gim;

	const links: { url: string; title: string }[] = [];
	let linkMatch;

	while ((linkMatch = linkRegex.exec(html)) !== null && links.length < maxResults) {
		const href = linkMatch[1];
		let decodedUrl = href;

		// Handle DuckDuckGo redirect URLs
		if (href.startsWith("/")) {
			const uddgMatch = href.match(/uddg=([^&]+)/);
			if (uddgMatch) {
				decodedUrl = decodeURIComponent(uddgMatch[1]);
			}
		}

		const title = stripHtml(linkMatch[2]);
		if (title && decodedUrl) {
			links.push({ url: decodedUrl, title });
		}
	}

	// Extract snippets
	const snippets: string[] = [];
	let snippetMatch;
	while ((snippetMatch = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
		snippets.push(stripHtml(snippetMatch[1]));
	}

	// Combine links and snippets
	for (let i = 0; i < links.length && i < maxResults; i++) {
		results.push({
			title: links[i].title,
			url: links[i].url,
			snippet: snippets[i] || "",
		});
	}

	return results;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	// Register the web search tool
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets of search results. Use this when you need current information, real-time data, or facts that may not be in your training data.",
		promptSnippet: "Search DuckDuckGo for current information",
		promptGuidelines: [
			"Use web_search to find current information, recent news, documentation, or specific facts.",
			"Search queries should be concise and specific for best results.",
			"Always cite sources from the search results in your responses.",
			"If search results are insufficient, try rephrasing the query.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The search query to execute",
				minLength: 1,
				maxLength: 500,
			}),
			max_results: Type.Optional(Type.Number({
				description: "Maximum number of results to return (default: 5, max: 10)",
				minimum: 1,
				maximum: 10,
				default: 5,
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const query = params.query.trim();
			const maxResults = Math.min(params.max_results ?? 5, 10);

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Search cancelled" }],
				};
			}

			// Stream progress update
			onUpdate?.({
				content: [{ type: "text", text: `Searching DuckDuckGo for "${query}"...` }],
			});

			try {
				// Try lite version first (more stable)
				let results = await searchDuckDuckGoLite(query, maxResults);

				// Fallback to regular HTML if no results
				if (results.length === 0) {
					results = await searchDuckDuckGo(query, maxResults);
				}

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Search cancelled" }],
					};
				}

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No results found. Try rephrasing the query or checking your connection." }],
						details: { query, results: [] },
					};
				}

				// Format results for display
				const formattedResults = results
					.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Snippet: ${r.snippet || "No snippet available"}`)
					.join("\n\n");

				return {
					content: [
						{ type: "text", text: `Search results for "${query}":\n\n${formattedResults}` },
					],
					details: { query, results },
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Search error: ${errorMessage}` }],
					isError: true,
					details: { query, error: errorMessage },
				};
			}
		},
	});

	// Also register a command for manual searches
	pi.registerCommand("search", {
		description: "Search the web using DuckDuckGo: /search <query>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /search <query>", "warning");
				return;
			}

			ctx.ui.notify(`Searching for "${args.trim()}"...`, "info");

			try {
				let results = await searchDuckDuckGoLite(args.trim(), 5);
				if (results.length === 0) {
					results = await searchDuckDuckGo(args.trim(), 5);
				}

				if (results.length === 0) {
					ctx.ui.notify("No results found", "warning");
					return;
				}

				// Create formatted output for notification
				const topResult = results[0];
				ctx.ui.notify(
					`Found ${results.length} result${results.length === 1 ? "" : "s"}: ${topResult.title}`.slice(0, 100) + "...",
					"success"
				);

				// Also return full results as a message
				pi.sendMessage({
					customType: "web-search-results",
					content: results
						.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet || ""}`)
						.join("\n\n"),
					display: true,
				});
			} catch (error) {
				ctx.ui.notify(`Search failed: ${error}`, "error");
			}
		},
	});

	// Notify on startup
	pi.on("session_start", async (_event, ctx) => {
		// Silent start - tool is available when needed
	});
}
