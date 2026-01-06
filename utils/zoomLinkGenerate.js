const axios = require("axios");
const { queryOne } = require("../config/database");

let cachedToken = null;
let tokenExpiry = null;

const generateInterViewLink = async (meetingDetails) => {
  // 1️⃣ Fetch Zoom config
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

  // 2️⃣ Validate input
  if (!meetingDetails?.start_time || !meetingDetails?.topic) {
    throw new Error("Invalid meeting details");
  }

  // 3️⃣ Get cached access token
  async function getAccessToken() {
    if (cachedToken && tokenExpiry > Date.now()) {
      return cachedToken;
    }

    const authUrl = "https://zoom.us/oauth/token";
    const authHeader = Buffer
      .from(`${zoomConfig.ZOOM_CLIENT_ID}:${zoomConfig.ZOOM_CLIENT_SECRET}`)
      .toString("base64");

    const response = await axios.post(
      `${authUrl}?grant_type=account_credentials&account_id=${zoomConfig.ZOOM_ACCOUNT_ID}`,
      null,
      {
        headers: { Authorization: `Basic ${authHeader}` },
      }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

    return cachedToken;
  }

  // 4️⃣ Create meeting
  const token = await getAccessToken();
  const zoomStartTime = new Date(
  meetingDetails.start_time.replace(' ', 'T') + 'Z'
).toISOString();
  const meetingConfig = {
    topic: meetingDetails.topic,
    type: 2,
    timezone: "UTC",
    start_time: zoomStartTime, // MUST be UTC ISO
    duration: meetingDetails.duration || 30,
    settings: {
      join_before_host: zoomConfig.Zoom_join_before_host === 1,
      waiting_room: zoomConfig.Zoom_waiting_room === 1,
    },
  };

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

  return {
    meeting_id: response.data.id,
    join_url: response.data.join_url,
    start_url: response.data.start_url,
    password: response.data.password,
  };
};

module.exports = { generateInterViewLink };
