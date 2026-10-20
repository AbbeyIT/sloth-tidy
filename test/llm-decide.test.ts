import { afterEach, describe, expect, it, vi } from "vitest";
import { hasVisibleDate, isPreferredDocumentDate, resolveCollisions } from "../src/decide.js";
import { decideForFile } from "../src/llm.js";
import type { FileCard } from "../src/scan.js";

const card: FileCard = {
  name: "scan0012.pdf", ext: "pdf", size: 1400,
  mtimeMs: Date.parse("2026-10-20T00:00:00.000Z"), path: "C:/Downloads/scan0012.pdf",
  snippet: "Meralco electricity statement dated 2026-10-03. Amount due PHP 2,176.44.",
};
const answer = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  category: "Invoices", description: "meralco-electricity-bill", documentDate: "2026-10-03",
  reason: "Meralco electricity bill", confidence: 0.94, ...overrides,
});

function mockOllamaContent(...contents: string[]) {
  const fetchMock = vi.fn();
  for (const content of contents) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: { content } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("decideForFile", () => {
  it("accepts the new contract and sends an enum-constrained JSON schema", async () => {
    const fetchMock = mockOllamaContent(answer({ folder: "../../scan0012.pdf", newName: "invented.exe" }));
    const result = await decideForFile(card, { folders: ["Invoices", "School"] });
    expect(result).toEqual({
      category: "Invoices", description: "meralco-electricity-bill", documentDate: "2026-10-03",
      reason: "Meralco electricity bill", confidence: 0.94, folder: "Invoices/2026", newName: "2026-10-03_meralco-electricity-bill.pdf",
    });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(request.format.properties.category.enum).toEqual(["Invoices", "School"]);
    expect(request).toMatchObject({ model: "qwen2.5:7b", stream: false, options: { temperature: 0 } });
    expect(request.messages[0].content).toContain("Write all text in English only");
    expect(request.messages[0].content).toContain("vscode-windows-installer");
    expect(request.messages[1].content).toContain("modified date");
  });

  it.each([
    ["non-JSON", "not JSON at all"],
    ["Chinese reason", answer({ reason: "电费账单" })],
    ["Chinese description", answer({ description: "电费-bill" })],
    ["category outside the enum", answer({ category: "../../Invoices" })],
    ["invalid description", answer({ description: "" })],
  ])("retries and falls back after invalid %s", async (_label, invalid) => {
    const fetchMock = mockOllamaContent(invalid, invalid);
    const result = await decideForFile(card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string).messages[1].content).toContain("previous response failed validation");
    expect(result).toMatchObject({ newName: card.name, folder: ".", reason: "model output invalid", confidence: 0 });
  });

  it("ignores model paths and always preserves the original extension", async () => {
    mockOllamaContent(answer({ folder: "../../escape/scan0012.pdf", newName: "fake.exe" }));
    const result = await decideForFile(card);
    expect(result.newName).toBe("2026-10-03_meralco-electricity-bill.pdf");
    expect(result.newName.endsWith(".pdf")).toBe(true);
    expect(result.folder).not.toContain("..");
    expect(result.folder).toBe("Invoices/2026"); // slash and year are added by code, never by the model
    expect(result.folder).not.toContain("scan0012.pdf");
  });

  it("uses the file mtime when the model says the document date is unknown", async () => {
    mockOllamaContent(answer({ category: "Work", description: "meeting-notes", documentDate: "unknown" }));
    const result = await decideForFile(card);
    expect(result.newName).toBe("2026-10-20_meeting-notes.pdf");
  });

  it("retries dates that are not visible in source content", async () => {
    const fetchMock = mockOllamaContent(answer({ documentDate: "2026-10-04" }), answer({ documentDate: "unknown" }));
    await expect(decideForFile(card)).resolves.toMatchObject({ newName: "2026-10-20_meralco-electricity-bill.pdf" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps low-confidence files in place", async () => {
    mockOllamaContent(answer({ confidence: 0.3 }));
    await expect(decideForFile(card)).resolves.toMatchObject({ newName: card.name, folder: ".", confidence: 0.3 });
  });

  it("refuses non-localhost URLs unless explicitly allowed", async () => {
    const fetchMock = mockOllamaContent(answer(), answer());
    vi.stubEnv("SLOTH_OLLAMA_URL", "https://ollama.example.com");
    await expect(decideForFile(card)).rejects.toThrow(/Refusing non-local Ollama URL/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(decideForFile(card, undefined, { allowRemote: true })).resolves.toMatchObject({ category: "Invoices" });
  });
});

describe("resolveCollisions", () => {
  it("adds numbered suffixes to duplicate destinations", () => {
    const items = [
      { newName: "invoice.pdf", folder: "Invoices" }, { newName: "invoice.pdf", folder: "Invoices" },
      { newName: "invoice.pdf", folder: "Invoices" }, { newName: "invoice.pdf", folder: "Receipts" },
    ];
    expect(resolveCollisions(items)).toEqual([
      { newName: "invoice.pdf", folder: "Invoices" }, { newName: "invoice (2).pdf", folder: "Invoices" },
      { newName: "invoice (3).pdf", folder: "Invoices" }, { newName: "invoice.pdf", folder: "Receipts" },
    ]);
  });
});

describe("document date evidence", () => {
  const billingCard = { ...card, snippet: "Billing period: 01\u201331 October 2026 | Due date: 05 November 2026" };

  it("normalizes both endpoints of an en-dash billing range and recognizes due dates", () => {
    expect(hasVisibleDate("2026-10-01", billingCard)).toBe(true);
    expect(hasVisibleDate("2026-10-31", billingCard)).toBe(true);
    expect(hasVisibleDate("2026-11-05", billingCard)).toBe(true);
    expect(isPreferredDocumentDate("2026-10-31", billingCard)).toBe(true);
    expect(isPreferredDocumentDate("2026-11-05", billingCard)).toBe(false);
  });

  it("recognizes month-day-year and day-month-year dates", () => {
    expect(hasVisibleDate("2026-11-05", { ...billingCard, snippet: "Issued November 05, 2026" })).toBe(true);
    expect(hasVisibleDate("2026-10-01", { ...billingCard, snippet: "Issued 01 October 2026" })).toBe(true);
    expect(hasVisibleDate("2026-10-31", { ...billingCard, snippet: "Billing period 01-31 October 2026" })).toBe(true);
  });

  it("accepts a visible due date but logs a warning instead of rejecting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockOllamaContent(answer({ documentDate: "2026-11-05" }));
    await expect(decideForFile(billingCard)).resolves.toMatchObject({ documentDate: "2026-11-05" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("due date or payment deadline"));
    warn.mockRestore();
  });
});
