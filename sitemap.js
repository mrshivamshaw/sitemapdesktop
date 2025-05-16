const { ipcRenderer } = require("electron");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const path = require("path");
const url = require("url");
const PQueue = require("p-queue").default;

// UI Elements
const urlInput = document.getElementById("urlInput");
const generateBtn = document.getElementById("generateBtn");
const exportBtn = document.getElementById("exportBtn");
const stopBtn = document.getElementById("stopBtn");
const statusMessage = document.getElementById("statusMessage");
const progressBar = document.getElementById("progressBar");
const siteMapTree = document.getElementById("siteMapTree");

// State
let baseUrl = "";
let totalLinks = 0;
let processedLinks = 0;
let isRunning = false;
const queue = new PQueue({ concurrency: 3 });
const tempFilePath = path.join(__dirname, "sitemap-temp.json");
const visitedFilePath = path.join(__dirname, "visited.txt");
let pendingUrls = [];
let pages = [];

// List of language codes (15 languages)
const languageCodes = [
    "en", "fr", "es", "de", "it", "pt", "ja", "zh", "ko", "ru",
    "ar", "nl", "sv", "pl", "tr"
];

// Possible language query parameter names
const languageParams = ["lang", "locale", "language"];

// Event listeners
generateBtn.addEventListener("click", checkLicenseAndGenerateSitemap);
exportBtn.addEventListener("click", exportSiteMap);
if (stopBtn) {
    stopBtn.addEventListener("click", () => {
        isRunning = false;
        statusMessage.textContent = "Crawl stopped by user.";
    });
}

// Helper function to check if URL is language-specific
function isLanguageUrl(urlToCheck) {
    try {
        const parsedUrl = new URL(urlToCheck);
        const pathname = parsedUrl.pathname;
        const searchParams = parsedUrl.searchParams;

        // Check for language query parameters (e.g., ?lang=en, ?locale=fr, ?language=de)
        for (const param of languageParams) {
            if (searchParams.has(param) && languageCodes.includes(searchParams.get(param))) {
                return true;
            }
        }

        // Check for language path segments (e.g., /en/, /fr/)
        const pathSegments = pathname.split("/").filter(Boolean);
        if (pathSegments.length > 0 && languageCodes.includes(pathSegments[0])) {
            return true;
        }

        return false;
    } catch (error) {
        console.error(`Error parsing URL ${urlToCheck}: ${error.message}`);
        return false;
    }
}

async function startSiteMapGeneration() {
    if (isRunning) {
        statusMessage.textContent = "Scan is already in progress...";
        return;
    }

    // Reset state
    pendingUrls = [];
    pages = [];
    totalLinks = 0;
    processedLinks = 0;
    siteMapTree.innerHTML = "";
    exportBtn.disabled = true;
    progressBar.style.width = "0%";
    isRunning = true;

    // Clear files
    try {
        await fs.writeFile(tempFilePath, "[]");
        await fs.writeFile(visitedFilePath, "");
    } catch (error) {
        statusMessage.textContent = `Error initializing files: ${error.message}`;
        isRunning = false;
        return;
    }

    // Get and validate URL
    baseUrl = urlInput.value.trim();
    if (!baseUrl) {
        statusMessage.textContent = "Please enter a valid URL";
        isRunning = false;
        return;
    }

    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = "https://" + baseUrl;
        urlInput.value = baseUrl;
    }

    try {
        const parsedUrl = new URL(baseUrl);
        const hostname = parsedUrl.hostname;
        statusMessage.textContent = `Starting scan of ${hostname}...`;
        generateBtn.disabled = true;

        // Start iterative crawling
        await crawlSiteIterative(baseUrl);

        // Write final pages to temp file
        await fs.writeFile(tempFilePath, JSON.stringify(pages));

        // Display results
        await displaySiteMap();
        exportBtn.disabled = false;
        statusMessage.textContent = `Scan complete! Found ${pages.length} unique URLs.`;
    } catch (error) {
        statusMessage.textContent = `Error: ${error.message}`;
    } finally {
        generateBtn.disabled = false;
        isRunning = false;
    }
}

async function crawlSiteIterative(startUrl) {
    pendingUrls.push(startUrl);
    const baseHostname = new URL(baseUrl).hostname;

    while ((pendingUrls.length > 0 || queue.size > 0 || queue.pending > 0) && isRunning) {
        if (pendingUrls.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
        }

        const currentUrl = pendingUrls.shift();
        if (await isVisited(currentUrl)) continue;

        // Normalize URL and remove language parameters/segments
        let normalizedUrl;
        try {
            const urlObj = new URL(currentUrl);
            urlObj.hash = "";
            // Remove language query parameters
            for (const param of languageParams) {
                if (urlObj.searchParams.has(param)) {
                    urlObj.searchParams.delete(param);
                }
            }
            // Remove language path segment (e.g., /en/)
            const pathSegments = urlObj.pathname.split("/").filter(Boolean);
            if (pathSegments.length > 0 && languageCodes.includes(pathSegments[0])) {
                urlObj.pathname = "/" + pathSegments.slice(1).join("/");
            }
            normalizedUrl = urlObj.href;
        } catch (error) {
            console.error(`Invalid URL: ${currentUrl}`);
            continue;
        }

        // Skip if this is a language-specific URL or already visited
        if (isLanguageUrl(currentUrl) || (await isVisited(normalizedUrl))) continue;

        await addVisited(normalizedUrl);
        statusMessage.textContent = `Crawling: ${normalizedUrl}`;

        queue.add(async () => {
            try {
                let response;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        response = await axios.get(normalizedUrl, {
                            timeout: 30000,
                            headers: { "User-Agent": "SitemapGenerator Bot" }
                        });
                        break;
                    } catch (error) {
                        if (error.response?.status === 429 || error.code === "ECONNABORTED") {
                            console.log(`Retry ${attempt}/3 for ${normalizedUrl} after delay...`);
                            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                            if (attempt === 3) throw error;
                        } else {
                            throw error;
                        }
                    }
                }

                console.log(`Status: ${response.status} for ${normalizedUrl}`);

                if (!response.headers["content-type"]?.includes("text/html")) {
                    console.log(`Skipped non-HTML: ${normalizedUrl}`);
                    return;
                }

                const $ = cheerio.load(response.data);
                const title = $("title").text().trim().replace(/[\n\r\t"]/g, " ").replace(/"/g, "\"");
                const links = [];
                let hasDynamicContent = $("script").length > 0 || response.data.includes("react") || response.data.includes("vue");

                // Check for canonical URL
                let canonicalUrl = normalizedUrl;
                const canonicalTag = $("link[rel='canonical']").attr("href");
                if (canonicalTag) {
                    try {
                        canonicalUrl = new URL(canonicalTag, normalizedUrl).href;
                    } catch (error) {
                        console.error(`Invalid canonical URL: ${canonicalTag}`);
                    }
                }

                // Check hreflang tags to skip language-specific pages
                const hreflangUrls = [];
                $("link[rel='alternate'][hreflang]").each((i, element) => {
                    const href = $(element).attr("href");
                    const hreflang = $(element).attr("hreflang");
                    if (href && hreflang !== "x-default") {
                        hreflangUrls.push(new URL(href, normalizedUrl).href);
                    }
                });

                // Skip if this is a language-specific URL based on hreflang
                if (hreflangUrls.length > 0 && hreflangUrls.includes(normalizedUrl)) {
                    console.log(`Skipped language-specific URL based on hreflang: ${normalizedUrl}`);
                    return;
                }

                $("a").each((i, element) => {
                    const href = $(element).attr("href");
                    if (href && !href.match(/\.(pdf|jpg|jpeg|png|gif|webp|svg|ico|css|js|woff|woff2|ttf|mp4|mp3|zip|rar)$/i)) {
                        links.push(href);
                    } else if (href) {
                        console.log(`Skipped link: ${href}`);
                    }
                });
                console.log(`Crawled: ${normalizedUrl}, Title: ${title}, Links found: ${links.length}${hasDynamicContent ? ", Possible dynamic content detected" : ""}`);

                // Store page with canonical URL
                pages.push({ url: canonicalUrl, title });

                // Periodically write to file
                if (pages.length % 1000 === 0) {
                    await fs.writeFile(tempFilePath, JSON.stringify(pages));
                    console.log(`Saved ${pages.length} pages to temp file`);
                }

                processedLinks++;
                totalLinks = Math.max(totalLinks, pages.length + links.length);
                progressBar.style.width = `${Math.min((processedLinks / (totalLinks || 1)) * 100, 100)}%`;

                for (const link of links) {
                    try {
                        const absoluteUrl = new URL(link, normalizedUrl).href;
                        const parsedUrl = new URL(absoluteUrl);
                        if (parsedUrl.hostname === baseHostname && !(await isVisited(absoluteUrl))) {
                            // Only add non-language URLs to pendingUrls
                            if (!isLanguageUrl(absoluteUrl)) {
                                pendingUrls.push(absoluteUrl);
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing link ${link}: ${error.message}`);
                    }
                }
            } catch (error) {
                console.error(`Error crawling ${normalizedUrl}: ${error.message}`);
            }
        });
    }

    await queue.onIdle();
}

async function isVisited(url) {
    try {
        const content = await fs.readFile(visitedFilePath, "utf8");
        return content.includes(url);
    } catch (error) {
        return false;
    }
}

async function addVisited(url) {
    try {
        await fs.appendFile(visitedFilePath, url + "\n");
    } catch (error) {
        console.error(`Error writing visited URL: ${error.message}`);
    }
}

async function displaySiteMap() {
    siteMapTree.innerHTML = "";
    const root = document.createElement("li");
    const rootUrl = new URL(baseUrl);
    root.innerHTML = `<strong>${rootUrl.hostname}</strong>`;
    const rootUl = document.createElement("ul");
    root.appendChild(rootUl);
    const pathElementMap = new Map();
    pathElementMap.set("", rootUl);

    try {
        const pages = JSON.parse(await fs.readFile(tempFilePath, "utf8"));

        const pathMap = {};
        for (const page of pages) {
            try {
                const parsedUrl = new URL(page.url);
                const path = parsedUrl.pathname;
                if (!pathMap[path]) {
                    pathMap[path] = page;
                }
            } catch (error) {
                continue;
            }
        }

        const sortedPaths = Object.keys(pathMap).sort((a, b) => {
            const depthA = a.split("/").filter(Boolean).length;
            const depthB = b.split("/").filter(Boolean).length;
            return depthA - depthB || a.localeCompare(b);
        });

        for (const path of sortedPaths) {
            const page = pathMap[path];
            const parts = path.split("/").filter(Boolean);
            let currentPath = "";

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const previousPath = currentPath;
                currentPath += "/" + part;

                if (!pathElementMap.has(currentPath)) {
                    const li = document.createElement("li");
                    li.dataset.path = currentPath;
                    const parentUl = pathElementMap.get(previousPath);

                    if (i === parts.length - 1) {
                        const title = page.title || part || "Home";
                        li.innerHTML = `<a href="${page.url}" target="_blank">${escapeHtml(title)}</a>`;
                    } else {
                        li.textContent = part || "/";
                        const newUl = document.createElement("ul");
                        li.appendChild(newUl);
                        pathElementMap.set(currentPath, newUl);
                    }

                    parentUl.appendChild(li);
                }
            }
        }
    } catch (error) {
        statusMessage.textContent = `Error displaying sitemap: ${error.message}`;
    }

    siteMapTree.appendChild(root);
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeXml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function exportSiteMap() {
    let xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
    xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
            http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
<!-- created with Electron Sitemap Generator -->
`;

    try {
        const pages = JSON.parse(await fs.readFile(tempFilePath, "utf8"));

        for (const page of pages) {
            xmlContent += "    <url>\n";
            xmlContent += `        <loc>${escapeXml(page.url)}</loc>\n`;
            xmlContent += `        <lastmod>${new Date().toISOString()}</lastmod>\n`;
            xmlContent += "        <priority>0.80</priority>\n";
            xmlContent += "    </url>\n";
        }
    } catch (error) {
        statusMessage.textContent = `Error exporting sitemap: ${error.message}`;
        return;
    }

    xmlContent += "</urlset>";

    const element = document.createElement("a");
    const file = new Blob([xmlContent], { type: "text/xml" });
    element.href = URL.createObjectURL(file);

    try {
        const domain = new URL(baseUrl).hostname;
        element.download = `sitemap-${domain}.xml`;
    } catch (error) {
        element.download = "sitemap.xml";
    }

    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);

    statusMessage.textContent = "Site map exported successfully!";
}

async function checkLicenseAndGenerateSitemap() {
    try {
        const isLicenseValid = await ipcRenderer.invoke("check-license");
        if (!isLicenseValid) {
            statusMessage.textContent = "Please activate your license to generate site map";
            return;
        }
        await startSiteMapGeneration();
    } catch (error) {
        statusMessage.textContent = `Error: ${error.message}`;
    }
}