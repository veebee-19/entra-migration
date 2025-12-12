import express from "express";
import authController from "../controllers/auth.controller.js";

const router = express.Router();

// POST /api/auth/login
router.post("/login", authController.loginWithJIT);

// POST /api/auth/logout
router.post("/logout", authController.logout);

// GET /api/auth/logout (for browser redirects)
router.get("/logout", authController.logout);

export default router;
