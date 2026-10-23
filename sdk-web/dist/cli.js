#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.findPublicDir = findPublicDir;
exports.destinationFor = destinationFor;
exports.servedUrlFor = servedUrlFor;
exports.install = install;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const swDefaults_1 = require("./swDefaults");
const TARGETS = ["public", "static", "www", "."];
function findPublicDir() {
    for (const dir of TARGETS) {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            return dir;
        }
    }
    return "public";
}
/**
 * Where the worker has to land inside the directory the site serves.
 *
 * The scope is a URL path, so it is split on `/` and rejoined with the
 * platform separator rather than concatenated.
 */
function destinationFor(servedDir) {
    const scopeSegments = swDefaults_1.SW_SCOPE.split("/").filter(Boolean);
    return path.join(servedDir, ...scopeSegments, swDefaults_1.SW_FILENAME);
}
/** The URL a copied file answers to, once `servedDir` is served at the root. */
function servedUrlFor(servedDir, destination) {
    return "/" + path.relative(servedDir, destination).split(path.sep).join("/");
}
function install(servedDir) {
    const destination = destinationFor(servedDir);
    const built = path.join(__dirname, "sw.js");
    const source = fs.existsSync(built) ? built : path.join(__dirname, "..", "src", "sw.ts");
    // The nested directory does not exist in a fresh project; without this the
    // copy fails with ENOENT and nothing is installed.
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return destination;
}
if (require.main === module) {
    const servedDir = (_a = process.argv[2]) !== null && _a !== void 0 ? _a : findPublicDir();
    const destination = install(servedDir);
    console.log(`espresso-notify-sw.js copied to ${destination}`);
    console.log(`Serve ${servedDir} at the root of your domain so the worker answers at ${swDefaults_1.SW_PATH}.`);
}
