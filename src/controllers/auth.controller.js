import authService from "../services/auth.service.js";
import { logger } from "../utils/logger.js";
import graphService from "../services/graph.service.js";

// Track users who have signed in (for dummy user check)
const signedInUsers = new Set();

class AuthController {
  loginWithJIT = async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          error: "Email and password are required",
        });
      }

      const result = await authService.loginWithJIT(email, password);

      if (result.success) {
        res.json({
          message: "Login successful",
          token: result.token,
          user: result.user,
        });
      } else {
        res.status(401).json({
          error: result.error,
        });
      }
    } catch (error) {
      logger.error("Login error", error);
      res.status(500).json({
        error: "Login failed",
        details: error.message,
      });
    }
  };

  logout = async (req, res) => {
    try {
      // Get post logout redirect URI from query params or use a default
      const postLogoutRedirectUri =
        req.query.postLogoutRedirectUri ||
        req.body.postLogoutRedirectUri ||
        process.env.POST_LOGOUT_REDIRECT_URI ||
        "http://localhost:3000";

      // Clear local application session
      if (req.session) {
        req.session.destroy((err) => {
          if (err) {
            logger.error("Error destroying session", err);
          }
        });
      }

      // Get Entra External ID logout URL from graph service
      const logoutUrlWithRedirect = graphService.getEntraLogoutUrl(
        postLogoutRedirectUri
      );

      logger.info(
        "Redirecting to Entra External ID logout:",
        logoutUrlWithRedirect
      );

      res.redirect(logoutUrlWithRedirect);
    } catch (error) {
      logger.error("Error during logout", error);
      res.status(500).json({
        error: "Logout failed",
        details: error.message,
      });
    }
  };

  checkDummyUserFirstSignInTokenIssuanceStart = async (req, res) => {
    try {
      logger.info("=== Received Token Issuance Request ===");
      logger.info("Request Body:", JSON.stringify(req.body, null, 2));

      const authEvent = req.body;

      // Extract user information
      const userId = authEvent?.data?.authenticationContext?.user?.id;
      const userEmail = authEvent?.data?.authenticationContext?.user?.mail;
      const userPrincipalName =
        authEvent?.data?.authenticationContext?.user?.userPrincipalName;

      logger.info(
        `User Details - ID: ${userId}, Email: ${userEmail}, UPN: ${userPrincipalName}`
      );

      // Fetch user data from Microsoft Graph to get extension attributes
      logger.info("Fetching user extension attributes from Graph API...");
      const userData = await graphService.getUserExtensionAttributes(userId);

      // Extract extension attribute 1
      const extensionAttr1 = graphService.extractExtensionAttribute1(userData);

      logger.info(`Extension Attribute 1: ${extensionAttr1}`);

      // Check if this is a dummy user (extension attribute 1 = "Y")
      if (extensionAttr1 && extensionAttr1.toString().toUpperCase() === "Y") {
        logger.info(
          "✓ User identified as DUMMY USER (Extension Attribute 1 = Y)"
        );

        // Check if this is their first sign-in
        const isFirstSignIn = !signedInUsers.has(userId);
        logger.info(
          `First Sign-In Check: ${
            isFirstSignIn ? "YES - FIRST TIME" : "NO - PREVIOUSLY SIGNED IN"
          }`
        );

        if (isFirstSignIn) {
          logger.info("🚫 BLOCKING USER - Adding block claim to token");

          // Add blocking claims to token
          const blockResponse = {
            data: {
              "@odata.type": "microsoft.graph.onTokenIssuanceStartResponseData",
              actions: [
                {
                  "@odata.type":
                    "microsoft.graph.tokenIssuanceStart.provideClaimsForToken",
                  claims: {
                    block_signin: "true",
                    block_reason:
                      "Dummy user cannot sign in for the first time",
                    user_status: "blocked",
                  },
                },
              ],
            },
          };

          logger.info("Block Claims Added to Token:", blockResponse);
          return res.status(200).json(blockResponse);
        } else {
          logger.info("✓ Allowing sign-in - User has signed in before");
        }

        // Track this sign-in
        signedInUsers.add(userId);
        logger.info(`User ${userId} marked as signed in`);
      } else {
        logger.info("✓ Normal user (not a dummy user) - continuing");
      }

      // Continue with normal token issuance (no custom claims)
      const continueResponse = {
        data: {
          "@odata.type": "microsoft.graph.onTokenIssuanceStartResponseData",
          actions: [
            {
              "@odata.type":
                "microsoft.graph.tokenIssuanceStart.provideClaimsForToken",
              claims: {},
            },
          ],
        },
      };

      logger.info("✓ Continue Response Sent:", continueResponse);
      return res.status(200).json(continueResponse);
    } catch (error) {
      logger.error("❌ ERROR occurred:", error);
      console.error("Error stack:", error.stack);

      // On error, continue to avoid blocking legitimate users
      const errorResponse = {
        data: {
          "@odata.type": "microsoft.graph.onTokenIssuanceStartResponseData",
          actions: [
            {
              "@odata.type":
                "microsoft.graph.tokenIssuanceStart.provideClaimsForToken",
              claims: {},
            },
          ],
        },
      };

      return res.status(200).json(errorResponse);
    }
  };

  checkDummyUserFirstSignInAttributeCollectionStart = async (req, res) => {
    try {
      logger.info("=== Received Request (OnAttributeCollectionStart) ===");
      logger.info("Request Body:", req.body);

      const authEvent = req.body;

      // Extract user information
      const userId = authEvent?.data?.authenticationContext?.user?.id;
      const userEmail = authEvent?.data?.authenticationContext?.user?.mail;
      const userPrincipalName =
        authEvent?.data?.authenticationContext?.user?.userPrincipalName;

      logger.info(
        `User Details - ID: ${userId}, Email: ${userEmail}, UPN: ${userPrincipalName}`
      );

      // Check if this is sign-in (user already exists) or sign-up (new user)
      const isSignIn = userId != null && userId !== "";
      logger.info(
        `Authentication Type: ${
          isSignIn ? "SIGN-IN (existing user)" : "SIGN-UP (new user)"
        }`
      );

      // For sign-in, user object will have extension attributes
      // For sign-up, we won't have them yet (they're being collected)
      let extensionAttr1 = null;
      let extensionAttrKey = null;

      if (isSignIn) {
        // Check user object for extension attributes
        const userObject = authEvent?.data?.authenticationContext?.user || {};

        for (const [key, value] of Object.entries(userObject)) {
          if (
            key.toLowerCase().includes("extensionattribute1") ||
            key.toLowerCase().includes("extension_attribute_1") ||
            key.toLowerCase().includes("extension_attribute1")
          ) {
            extensionAttr1 = value;
            extensionAttrKey = key;
            break;
          }
        }

        logger.info(
          `Extension Attribute Found - Key: ${extensionAttrKey}, Value: ${extensionAttr1}`
        );

        // Check if this is a dummy user (extension attribute 1 = "Y")
        if (extensionAttr1 && extensionAttr1.toString().toUpperCase() === "Y") {
          logger.info(
            "✓ User identified as DUMMY USER (Extension Attribute 1 = Y)"
          );

          // Check if this is their first sign-in
          const isFirstSignIn = !signedInUsers.has(userId);
          logger.info(
            `First Sign-In Check: ${
              isFirstSignIn ? "YES - FIRST TIME" : "NO - PREVIOUSLY SIGNED IN"
            }`
          );

          if (isFirstSignIn) {
            logger.info(
              "🚫 BLOCKING USER - Dummy user attempting first sign-in"
            );

            // Return block page - THIS WORKS with OnAttributeCollectionStart!
            const blockResponse = {
              data: {
                "@odata.type":
                  "microsoft.graph.onAttributeCollectionStartResponseData",
                actions: [
                  {
                    "@odata.type":
                      "microsoft.graph.attributeCollectionStart.showBlockPage",
                    title: "Access Denied",
                    message:
                      "Dummy user accounts cannot sign in for the first time. Please contact your system administrator for assistance.",
                  },
                ],
              },
            };

            logger.info("Block Response Sent:", blockResponse);
            return res.status(200).json(blockResponse);
          } else {
            logger.info("✓ Allowing sign-in - User has signed in before");
          }

          // Track this sign-in
          signedInUsers.add(userId);
          logger.info(`User ${userId} marked as signed in`);
        } else {
          logger.info("✓ Normal user (not a dummy user) - continuing");
        }
      } else {
        logger.info(
          "✓ Sign-up flow detected - continuing with attribute collection"
        );
      }

      // Continue with normal authentication flow
      const continueResponse = {
        data: {
          "@odata.type":
            "microsoft.graph.onAttributeCollectionStartResponseData",
          actions: [
            {
              "@odata.type":
                "microsoft.graph.attributeCollectionStart.continueWithDefaultBehavior",
            },
          ],
        },
      };

      logger.info("✓ Continue Response Sent:", continueResponse);
      return res.status(200).json(continueResponse);
    } catch (error) {
      logger.info("❌ ERROR occurred:", error);
      console.error("Error stack:", error.stack);

      // On error, continue to avoid blocking legitimate users
      const errorResponse = {
        data: {
          "@odata.type":
            "microsoft.graph.onAttributeCollectionStartResponseData",
          actions: [
            {
              "@odata.type":
                "microsoft.graph.attributeCollectionStart.continueWithDefaultBehavior",
            },
          ],
        },
      };

      return res.status(200).json(errorResponse);
    }
  };
}

export default new AuthController();
