const axios = require("axios");

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagValues(xml, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `<(?:[\\w-]+:)?${escapedTag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${escapedTag}>`,
    "gi",
  );
  return [...xml.matchAll(expression)].map((match) => decodeXml(match[1].trim()));
}

function firstTagValue(xml, tag) {
  return tagValues(xml, tag)[0] || "";
}

function parseRecord(itemXml) {
  const fields = [
    "RollNo", "FormNo", "StudentName", "EntryDate", "LastModifiedDate",
    "ColA", "ColB", "ColC", "RfidCardNo", "ExpiryDate", "FrontPic",
    "RightPic", "LeftPic", "TopPic", "ThumbId", "ModifyStatus",
    "ModifyRemarks", "BlockRemarks", "BlockStatus", "BlockDate",
    "FetchStatus", "LastSyncTime", "RecognitionMode", "Gender",
    "TransportStatus", "HostelStatus", "TransportFeeBalance", "Status",
  ];
  return Object.fromEntries(fields.map((field) => [field, firstTagValue(itemXml, field)]));
}

class UisSoapClient {
  constructor({ url = process.env.UIS_API_URL, userId = process.env.UIS_API_USER_ID, password = process.env.UIS_API_PASSWORD } = {}) {
    this.url = url;
    this.userId = userId;
    this.password = password;
  }

  assertConfigured() {
    if (!this.url || !this.userId || !this.password) {
      throw new Error("UIS_API_URL, UIS_API_USER_ID, and UIS_API_PASSWORD must be configured");
    }
  }

  async call(method, fields = {}) {
    this.assertConfigured();
    const body = Object.entries({ UserId: this.userId, Password: this.password, ...fields })
      .map(([name, value]) => `<${name} xsi:type="xsd:string">${escapeXml(value)}</${name}>`)
      .join("");
    const envelope = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SOAP-ENV:Body><ns8898:${method} xmlns:ns8898="http://tempuri.org">${body}</ns8898:${method}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    const response = await axios.post(this.url, envelope, {
      headers: { "Content-Type": "text/xml; charset=ISO-8859-1" },
      responseType: "text",
      timeout: Number(process.env.UIS_API_TIMEOUT_MS || 30000),
      // UIS may return a SOAP fault with a non-2xx HTTP status. Keep the
      // response body so the ResponseCode/Message below remains useful.
      validateStatus: () => true,
    });
    const xml = String(response.data || "");
    const responseCode = firstTagValue(xml, "ResponseCode");
    const message = firstTagValue(xml, "Message");
    if (responseCode !== "100") {
      throw new Error(`UIS ${method} failed${responseCode ? ` (${responseCode})` : ""}: ${message || "unknown response"}`);
    }
    return { xml, message };
  }

  async getNewRegisteredUsers(dateFrom, dateTo) {
    const { xml } = await this.call("GetNewRegisterUserList", { DateFrom: dateFrom, DateTo: dateTo });
    return tagValues(xml, "item").map(parseRecord);
  }

  async getModifiedUsers() {
    const { xml } = await this.call("GetModifiedUserList");
    return tagValues(xml, "item").map(parseRecord);
  }

  async getUserDetail(formNo) {
    const { xml } = await this.call("GetRegisteredInUserDetail", { FormNo: formNo });
    const item = tagValues(xml, "item")[0];
    if (!item) throw new Error(`UIS returned no detail record for FormNo ${formNo}`);
    return parseRecord(item);
  }

  async markRegisteredUser(formNo) {
    await this.call("MarkRegisteredUser", { FormNo: formNo });
  }
}

module.exports = { UisSoapClient };
