#!/usr/bin/env node
const path = require("path");
const fs = require("fs").promises;

async function run() {
  try {
    // Run hardhat compile programmatically
    // require hardhat runtime environment
    const hre = require("hardhat");
    console.log("Running hardhat compile...");
    await hre.run("compile");

    const repoRoot = path.resolve(__dirname, "..");
    const artifactsDir = path.join(repoRoot, "artifacts", "contracts");
    const outDir = path.join(repoRoot, "frontend", "src", "abi");

    // ensure output dir exists
    await fs.mkdir(outDir, { recursive: true });

    console.log("Scanning artifacts in", artifactsDir);

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && full.endsWith(".json")) {
          try {
            const content = await fs.readFile(full, "utf8");
            // validate JSON
            JSON.parse(content);
            const name = path.basename(full);
            const dest = path.join(outDir, name);
            await fs.writeFile(dest, content, "utf8");
            console.log("Copied", name);
          } catch (err) {
            console.warn("Skipping file (invalid json?):", full, err.message);
          }
        }
      }
    }

    await walk(artifactsDir);
    console.log("Done. ABI files updated in", outDir);
    process.exit(0);
  } catch (err) {
    console.error("Failed to export ABIs:", err);
    process.exit(1);
  }
}

run();
