import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { initTheme } from "./theme.js";
import App from "./App.jsx";

initTheme();
createRoot(document.getElementById("root")).render(<App />);
