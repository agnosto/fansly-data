import { $ } from "bun";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer";
import { format } from "prettier";

// Configuration
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const PRETTIFY_JS = process.env.PRETTIFY_JS === "true" || false;
const FANSLY_TOKEN = process.env.FANSLY_TOKEN || ""; // Optional token for authenticated requests

interface CheckKeyInfo {
    pattern: string;
    value: string;
}

interface HeaderInfo {
    name: string;
    description: string;
}

interface ApiRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
}

async function main() {
    console.log("Starting Fansly JS monitor...");
    // Create directories if they don't exist
    await fs.mkdir("data/fansly-js", { recursive: true });
    await fs.mkdir("data/metadata", { recursive: true });

    // Fetch the main JS file
    console.log("Fetching Fansly homepage to find main JS file...");
    const homepage = await fetch("https://fansly.com/", {
        headers: {
            "User-Agent": USER_AGENT
        }
    }).then(res => res.text());

    // Extract main JS filename
    const mainJsMatch = homepage.match(/\ssrc\s*=\s*"(main\..*?\.js)"/);
    if (!mainJsMatch || !mainJsMatch[1]) {
        console.error("Could not find main JS file in homepage");
        process.exit(1);
    }

    const mainJsFilename = mainJsMatch[1];
    console.log(`Found main JS file: ${mainJsFilename}`);

    // Download the JS file
    console.log("Downloading JS file...");
    const jsContent = await fetch(`https://fansly.com/${mainJsFilename}`, {
        headers: {
            "User-Agent": USER_AGENT
        }
    }).then(res => res.text());

    // Calculate hash
    const hash = crypto.createHash("sha256").update(jsContent).digest("hex");
    console.log(`JS file hash: ${hash}`);

    // Check if we already have this file by hash
    const jsDir = "data/fansly-js";
    const metadataDir = "data/metadata";

    // Create timestamp for filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsFilename = `${timestamp}_${hash.substring(0, 8)}_${mainJsFilename.replace(/\//g, "_")}`;
    const jsPath = path.join(jsDir, jsFilename);

    // Check if file with this hash already exists
    const existingFiles = await fs.readdir(jsDir);
    const hashExists = existingFiles.some(file => file.includes(hash.substring(0, 8)));
    if (hashExists) {
        console.log("This JS file already exists in the repository. No changes detected.");
        return;
    }

    // Process JS content - prettify if requested
    let processedJsContent = jsContent;
    if (PRETTIFY_JS) {
        try {
            console.log("Prettifying JS content...");
            processedJsContent = await format(jsContent, {
                parser: "babel",
                printWidth: 100,
                tabWidth: 2,
                singleQuote: true,
                trailingComma: "es5"
            });
        } catch (error) {
            console.warn("Failed to prettify JS content:", error);
            // Fall back to original content
            processedJsContent = jsContent;
        }
    }

    // Save the JS file
    console.log(`Saving JS file to ${jsPath}`);
    await fs.writeFile(jsPath, processedJsContent);

    // Extract check keys
    console.log("Extracting check keys...");
    const checkKeys = extractCheckKeys(jsContent);

    // Extract headers from JS content
    const staticHeaders = extractHeaders(jsContent);

    // Use Puppeteer to capture actual API requests and headers
    console.log("Starting Puppeteer to capture actual API requests...");
    const apiRequests = await captureApiRequests();

    // Extract unique headers from API requests
    const dynamicHeaders = extractHeadersFromRequests(apiRequests);

    // Combine static and dynamic headers
    const headerMap = new Map<string, HeaderInfo>();

    // Add static headers first
    for (const header of staticHeaders) {
        headerMap.set(header.name.toLowerCase(), header);
    }

    // Add dynamic headers, only if they don't already exist
    for (const header of dynamicHeaders) {
        if (!headerMap.has(header.name.toLowerCase())) {
            headerMap.set(header.name.toLowerCase(), header);
        }
    }

    // Convert map back to array
    const allHeaders = Array.from(headerMap.values());

    // Save metadata
    const metadata = {
        timestamp: new Date().toISOString(),
        filename: mainJsFilename,
        hash,
        checkKeys,
        headers: allHeaders,
        apiRequests: apiRequests.map(req => ({
            url: req.url,
            method: req.method,
            headers: redactSensitiveHeaders(req.headers)
        }))
    };

    const metadataPath = path.join(metadataDir, `${timestamp}_metadata.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Update latest.json with the most recent metadata
    await fs.writeFile(path.join(metadataDir, "latest.json"), JSON.stringify({
        timestamp: new Date().toISOString(),
        jsFile: jsFilename,
        hash,
        checkKeys,
        headers: allHeaders.map(h => h.name)
    }, null, 2));

    console.log("Done!");
}

function extractCheckKeys(jsContent: string): CheckKeyInfo[] {
    const checkKeys: CheckKeyInfo[] = [];

    // Pattern 1: The array reverse pattern
    const pattern1 = /this\.checkKey_\s*=\s*\["([^"]+)","([^"]+)"\]\.reverse\(\)\.join\("-"\)\+"([^"]+)"/;
    const match1 = jsContent.match(pattern1);
    if (match1 && match1[1] && match1[2] && match1[3]) {
        const part1 = match1[1];
        const part2 = match1[2];
        const part3 = match1[3];
        const key = `${part2}-${part1}${part3}`;
        checkKeys.push({ pattern: "Array Reverse", value: key });
    }

    // Pattern 2: The push pattern
    const pattern2 = /let\s+i\s*=\s*\[\s*\]\s*;\s*i\.push\s*\(\s*"([^"]+)"\s*\)\s*,\s*i\.push\s*\(\s*"([^"]+)"\s*\)\s*,\s*i\.push\s*\(\s*"([^"]+)"\s*\)\s*,\s*this\.checkKey_\s*=\s*i\.join\s*\(\s*"-"\s*\)/;
    const match2 = jsContent.match(pattern2);
    if (match2 && match2[1] && match2[2] && match2[3]) {
        const part1 = match2[1];
        const part2 = match2[2];
        const part3 = match2[3];
        const key = `${part1}-${part2}-${part3}`;
        checkKeys.push({ pattern: "Push", value: key });
    }

    // Look for any other patterns that set checkKey_
    const otherPattern = /this\.checkKey_\s*=\s*([^;]+)/g;
    let otherMatch;
    while ((otherMatch = otherPattern.exec(jsContent)) !== null) {
        const expression = otherMatch[1]?.trim();
        if (expression && !expression.startsWith('["') && !expression.startsWith('i.join')) {
            checkKeys.push({ pattern: "Other", value: expression });
        }
    }

    return checkKeys;
}

function extractHeaders(jsContent: string): HeaderInfo[] {
    const headers: HeaderInfo[] = [];

    // Common Fansly headers
    const headerPatterns = [
        { regex: /["']fansly-client-check["']/g, name: "fansly-client-check", description: "Client check hash value" },
        { regex: /["']fansly-client-id["']/g, name: "fansly-client-id", description: "Client device ID" },
        { regex: /["']fansly-client-ts["']/g, name: "fansly-client-ts", description: "Client timestamp" },
        { regex: /["']fansly-session-id["']/g, name: "fansly-session-id", description: "Session ID" }
    ];

    for (const pattern of headerPatterns) {
        if (pattern.regex.test(jsContent)) {
            headers.push({ name: pattern.name, description: pattern.description });
        }
    }

    // Look for any other headers being set
    const headerSetPattern = /key:\s*["']([^"']+)["']/g;
    let headerMatch;
    while ((headerMatch = headerSetPattern.exec(jsContent)) !== null) {
        const headerName = headerMatch[1]?.trim();
        if (headerName && headerName.startsWith('fansly-') && !headers.some(h => h.name === headerName)) {
            headers.push({ name: headerName, description: "Unknown Fansly header" });
        }
    }

    return headers;
}

function extractHeadersFromRequests(requests: ApiRequest[]): HeaderInfo[] {
    const headers: HeaderInfo[] = [];
    const seenHeaders = new Set<string>();

    for (const request of requests) {
        // First, check regular headers
        for (const headerName of Object.keys(request.headers)) {
            if (headerName.toLowerCase().startsWith('fansly-') && !seenHeaders.has(headerName.toLowerCase())) {
                seenHeaders.add(headerName.toLowerCase());
                headers.push({
                    name: headerName,
                    description: `Captured from ${request.method} request to ${new URL(request.url).pathname}`
                });
            }
        }

        // Then, check access-control-request-headers in OPTIONS requests
        if (request.method === 'OPTIONS' && request.headers['access-control-request-headers']) {
            const requestedHeaders = request.headers['access-control-request-headers']
                .split(',')
                .map(h => h.trim());

            for (const headerName of requestedHeaders) {
                if (headerName.toLowerCase().startsWith('fansly-') && !seenHeaders.has(headerName.toLowerCase())) {
                    seenHeaders.add(headerName.toLowerCase());
                    headers.push({
                        name: headerName,
                        description: `Listed in access-control-request-headers for ${new URL(request.url).pathname}`
                    });
                }
            }
        }
    }

    return headers;
}


function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
    const redactedHeaders = { ...headers };

    // Redact specific Fansly headers
    if (redactedHeaders['fansly-client-id']) {
        redactedHeaders['fansly-client-id'] = '[REDACTED]';
    }

    if (redactedHeaders['fansly-client-check']) {
        redactedHeaders['fansly-client-check'] = '[REDACTED]';
    }

    if (redactedHeaders['fansly-session-id']) {
        redactedHeaders['fansly-session-id'] = '[REDACTED]';
    }

    // Redact sensitive information
    if (redactedHeaders.authorization) {
        redactedHeaders.authorization = '[REDACTED]';
    }
    if (redactedHeaders.cookie) {
        redactedHeaders.cookie = '[REDACTED]';
    }

    // Redact any other potentially sensitive headers
    for (const [key, _] of Object.entries(redactedHeaders)) {
        if (
            key.toLowerCase().includes('token') ||
            key.toLowerCase().includes('auth') ||
            key.toLowerCase().includes('key') ||
            key.toLowerCase().includes('secret')
        ) {
            redactedHeaders[key] = '[REDACTED]';
        }
    }

    return redactedHeaders;
}

async function captureApiRequests(): Promise<ApiRequest[]> {
    const requests: ApiRequest[] = [];
    try {
        // Launch browser
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        try {
            const page = await browser.newPage();
            // Set user agent
            await page.setUserAgent(USER_AGENT);

            // Collect API requests
            await page.setRequestInterception(true);
            page.on('request', request => {
                const url = request.url();
                if (url.includes('apiv3.fansly.com/api')) {
                    requests.push({
                        url,
                        method: request.method(),
                        headers: request.headers() as Record<string, string>
                    });
                }
                request.continue();
            });

            // Navigate to Fansly
            await page.goto('https://fansly.com', { waitUntil: 'networkidle2' });

            // If token is provided, inject it
            if (FANSLY_TOKEN) {
                console.log("Injecting authentication token...");
                await page.evaluate((token) => {
                    const session = {
                        "id": "",
                        "accountId": "",
                        "deviceId": null,
                        "token": token,
                        "metadata": null
                    };
                    localStorage.setItem('session_active_session', JSON.stringify(session));
                }, FANSLY_TOKEN);

                // Refresh to apply token
                await page.reload({ waitUntil: 'networkidle2' });

                // Navigate to a few pages to capture more API requests
                await page.goto('https://fansly.com/home', { waitUntil: 'networkidle2' });
                await new Promise(resolve => setTimeout(resolve, 5000));
                await page.goto('https://fansly.com/messages', { waitUntil: 'networkidle2' });
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            console.log(`Captured ${requests.length} API requests`);
        } finally {
            await browser.close();
        }
    } catch (error) {
        console.error("Error capturing API requests:", error);
        // Return empty array if Puppeteer fails
        return [];
    }

    return requests;
}

main().catch(error => {
    console.error("Error:", error);
    process.exit(1);
});

