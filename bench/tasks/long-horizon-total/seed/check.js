import fs from "node:fs";

const text = fs.readFileSync("report.md", "utf8");
if (!text.includes("150") || !text.includes("30")) {
  console.error("report.md 缺 150/30");
  process.exit(1);
}
console.log("ok");
