// Zoom Meeting Link Generator
// This module handles the creation of Zoom meeting links for interviews
// Uses Zoom OAuth2 Server-to-Server authentication with token caching

const axios = require("axios");
const { queryOne } = require("../config/database");

// Token caching variables to avoid unnecessary API calls
let cachedToken = null;
let tokenExpiry = null;

/**
 * Generate a Zoom meeting link for an interview
 * Creates a scheduled Zoom meeting and returns the meeting details
 * 
 * @param {Object} meetingDetails - Meeting configuration object
 * @param {string} meetingDetails.start_time - Meeting start time (UTC ISO format)
 * @param {string} meetingDetails.topic - Meeting topic/title
 * @param {number} [meetingDetails.duration] - Meeting duration in minutes (default: 30)
 * @returns {Promise<Object>} Object containing meeting_id, join_url, start_url, and password
 * @throws {Error} If Zoom config not found or invalid meeting details
 */
const generateInterViewLink = async (meetingDetails) => {
  // Step 1: Fetch Zoom configuration from database
  const zoomConfig = await queryOne(`
    SELECT *
    FROM meeting_settings
    WHERE type = 'zoom'
      AND status = 'active'
    LIMIT 1
  `);

  if (!zoomConfig) {
    throw new Error("Zoom meeting configuration not found");
  }

  // Step 2: Validate required input parameters
  if (!meetingDetails?.start_time || !meetingDetails?.topic) {
    throw new Error("Invalid meeting details");
  }

  /**
   * Get Zoom OAuth access token with caching
   * Uses cached token if still valid, otherwise fetches a new one
   * Token is cached to reduce API calls and improve performance
   * 
   * @returns {Promise<string>} Zoom OAuth access token
   */
  async function getAccessToken() {
    // Return cached token if it's still valid (not expired)
    if (cachedToken && tokenExpiry > Date.now()) {
      return cachedToken;
    }

    // Prepare OAuth2 Server-to-Server authentication
    const authUrl = "https://zoom.us/oauth/token";
    // Create Basic Auth header from client ID and secret
    const authHeader = Buffer
      .from(`${zoomConfig.ZOOM_CLIENT_ID}:${zoomConfig.ZOOM_CLIENT_SECRET}`)
      .toString("base64");

    // Request access token using account credentials grant type
    const response = await axios.post(
      `${authUrl}?grant_type=account_credentials&account_id=${zoomConfig.ZOOM_ACCOUNT_ID}`,
      null,
      {
        headers: { Authorization: `Basic ${authHeader}` },
      }
    );

    // Cache the token and set expiry time (subtract 60 seconds for safety margin)
    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

    return cachedToken;
  }

  // Step 3: Get access token (cached or fresh)
  const token = await getAccessToken();
  
  // Step 4: Create Zoom meeting
  // Convert start_time to ISO format required by Zoom API
  const zoomStartTime = new Date(
  meetingDetails.start_time.replace(' ', 'T') + 'Z'
).toISOString();
  
  // Configure meeting settings
  const meetingConfig = {
    topic: meetingDetails.topic,
    type: 2, // Scheduled meeting type
    timezone: "UTC",
    start_time: zoomStartTime, // MUST be UTC ISO format
    duration: meetingDetails.duration || 30, // Default 30 minutes
    settings: {
      join_before_host: zoomConfig.Zoom_join_before_host === 1,
      waiting_room: zoomConfig.Zoom_waiting_room === 1,
    },
  };

  // Create the meeting via Zoom API
  const response = await axios.post(
    "https://api.zoom.us/v2/users/me/meetings",
    meetingConfig,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  // Return meeting details for storage and use
  return {
    meeting_id: response.data.id,
    join_url: response.data.join_url,
    start_url: response.data.start_url,
    password: response.data.password,
  };
};

module.exports = { generateInterViewLink };
