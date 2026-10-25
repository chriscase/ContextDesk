import base from "./playwright.config.js";
import {defineConfig} from "@playwright/test";
const {webServer: _fixture, ...config} = base;
export default defineConfig({...config,testMatch:"44-structured-evidence-labels.spec.ts",retries:0,workers:1});
