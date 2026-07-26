/** Authored by: Mohit Singh */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  dedupeRecipients,
  normalizeEmail,
  normalizePhone,
  parseCsv,
  parseUploadedRecipients,
  type Recipient,
} from "./recipientParse.js";

describe("normalizePhone", () => {
  it("keeps an E.164 number, stripping formatting", () => {
    expect(normalizePhone("+91 84455 88806")).toBe("+918445588806");
    expect(normalizePhone("+971 (58) 531-5770")).toBe("+971585315770");
  });
  it("coerces 00-prefixed international to +", () => {
    expect(normalizePhone("0091 8445588806")).toBe("+918445588806");
  });
  it("coerces a bare 10-digit Indian mobile number to +91, matching the +91-prefixed form", () => {
    expect(normalizePhone("98765 43210")).toBe("+919876543210");
    expect(normalizePhone("9876543210")).toBe(normalizePhone("+91 9876543210"));
  });
  it("leaves a non-Indian-mobile-shaped local number digit-only", () => {
    // 11 digits or starting 0-5 isn't the Indian-mobile pattern — kept as best-effort digits.
    expect(normalizePhone("04455 88806")).toBe("0445588806");
  });
  it("returns null for too-few digits", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and validates", () => {
    expect(normalizeEmail("  Info@Gym.COM ")).toBe("info@gym.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with commas and embedded newlines", () => {
    const rows = parseCsv('a,b\n"x,y","line1\nline2"\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,y", "line1\nline2"],
    ]);
  });
  it("handles doubled quotes and a BOM", () => {
    const rows = parseCsv('\uFEFFname\n"He said ""hi"""');
    expect(rows).toEqual([["name"], ['He said "hi"']]);
  });
});

describe("parseUploadedRecipients", () => {
  it("maps OCR-export headers from a CSV to recipients", async () => {
    const csv =
      "#,Name,Category,Address,Phone,Email\n" +
      "1,BAJRANG FITNESS,Gym,Haldwani,+91 84455 88806,info@bajrang.com\n" +
      "2,No Contact Row,,,,\n"; // still valid — has a name
    const base64 = Buffer.from(csv, "utf-8").toString("base64");
    const recipients = await parseUploadedRecipients(base64, "ocr.csv");
    expect(recipients).toHaveLength(2);
    expect(recipients[0]).toEqual({
      businessName: "BAJRANG FITNESS",
      businessType: "Gym",
      location: "Haldwani",
      phone: "+918445588806",
      email: "info@bajrang.com",
    });
    expect(recipients[1]!.phone).toBeNull();
  });

  it("skips rows with no business name", async () => {
    const csv = "Name,Phone\n,+919999999999\nReal Gym,+918888888888\n";
    const base64 = Buffer.from(csv, "utf-8").toString("base64");
    const recipients = await parseUploadedRecipients(base64, "x.csv");
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.businessName).toBe("Real Gym");
  });

  it("parses an XLSX upload", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("S");
    sheet.addRow(["Name", "Phone", "Email"]);
    sheet.addRow(["Flow Fitness", "+919286836869", "hi@flow.com"]);
    const buf = await wb.xlsx.writeBuffer();
    const base64 = Buffer.from(buf).toString("base64");
    const recipients = await parseUploadedRecipients(base64, "sheet.xlsx");
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({
      businessName: "Flow Fitness",
      phone: "+919286836869",
      email: "hi@flow.com",
    });
  });
});

describe("dedupeRecipients", () => {
  const r = (over: Partial<Recipient>): Recipient => ({
    businessName: "X",
    businessType: null,
    location: null,
    phone: null,
    email: null,
    ...over,
  });

  it("collapses duplicates by phone, then email, then name+location", () => {
    const input = [
      r({ businessName: "A", phone: "+911111111111" }),
      r({ businessName: "A dup", phone: "+911111111111" }), // same phone → dropped
      r({ businessName: "B", email: "b@x.com" }),
      r({ businessName: "B dup", email: "b@x.com" }), // same email → dropped
      r({ businessName: "C", location: "Delhi" }),
      r({ businessName: "C", location: "Delhi" }), // same name+location → dropped
      r({ businessName: "C", location: "Mumbai" }), // different location → kept
    ];
    const out = dedupeRecipients(input);
    expect(out.map((x) => x.businessName)).toEqual(["A", "B", "C", "C"]);
    expect(out[2]!.location).toBe("Delhi");
    expect(out[3]!.location).toBe("Mumbai");
  });
});
