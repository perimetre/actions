/**
 * Centralized Slack user lookup logic for GitHub Actions workflow
 *
 * This module provides functions to match GitHub users to Slack users and build
 * Slack message blocks for PR notifications.
 *
 * ## User Matching Strategy (Priority Order)
 * 1. Manual user mapping via SLACK_USER_MAPPING variable (highest priority)
 * 2. Email matching (GitHub email → Slack email via users.lookupByEmail API)
 * 3. Name/username fuzzy matching (lowest priority fallback)
 *
 * ## Required GitHub Secrets
 * - SLACK_BOT_TOKEN: Slack bot token with scopes:
 *   - chat:write.customize (post messages as different users)
 *   - users:read (read user information)
 *   - users:read.email (read user email addresses)
 *
 * ## Required GitHub Variables
 * - SLACK_CHANNEL_ID: The Slack channel ID for notifications (e.g., "C01234567")
 *
 * ## Optional GitHub Variables
 * - SLACK_USER_MAPPING: JSON mapping of GitHub username to Slack user ID
 *   Example: {"github-user": "U12345678", "another-user": "U87654321"}
 *   To get Slack user IDs: User profile → More → Copy member ID
 *
 * @module slack-user-lookup
 * @example
 * // Usage in GitHub Actions workflow script:
 * const { findSlackUser, getSlackUserProfile, buildCommentBlocks } = require('./.github/scripts/slack-user-lookup.js');
 *
 * const slackUser = await findSlackUser({
 *   githubUsername: 'octocat',
 *   slackToken: process.env.SLACK_BOT_TOKEN,
 *   userMapping: process.env.SLACK_USER_MAPPING,
 *   github,
 *   core
 * });
 *
 * const profile = getSlackUserProfile(slackUser);
 * core.setOutput('username', profile.username);
 * core.setOutput('icon_url', profile.icon_url);
 */

/**
 * @typedef {Object} SlackUser
 * @property {string} id - Slack user ID (e.g., "U12345678")
 * @property {string} name - Slack username
 * @property {string} real_name - User's real name
 * @property {Object} profile - User's profile information
 * @property {string} [profile.display_name] - Display name
 * @property {string} [profile.image_original] - Original size avatar URL
 * @property {string} [profile.image_512] - 512px avatar URL
 * @property {string} [profile.image_192] - 192px avatar URL
 * @property {string} [profile.image_72] - 72px avatar URL
 */

/**
 * @typedef {Object} SlackUserProfile
 * @property {string} username - Slack display name to use for message
 * @property {string} icon_url - Slack avatar URL to use for message
 * @property {boolean} matched - Whether user was successfully matched
 */

/**
 * @typedef {Object} GitHubAPIClient
 * @property {Object} rest - GitHub REST API methods
 */

/**
 * @typedef {Object} CoreUtilities
 * @property {Function} info - Log info message
 * @property {Function} warning - Log warning message
 * @property {Function} setOutput - Set workflow output
 */

/**
 * @typedef {Object} GitHubContext
 * @property {Object} repo - Repository information
 * @property {string} repo.owner - Repository owner
 * @property {string} repo.repo - Repository name
 */

/**
 * Find Slack user by GitHub username
 *
 * This function attempts to match a GitHub user to a Slack user using multiple methods:
 * 1. Manual mapping via SLACK_USER_MAPPING environment variable (highest priority)
 * 2. Email matching (GitHub email → Slack email via users.lookupByEmail)
 * 3. Name/username fuzzy matching (fallback)
 *
 * @param {Object} params - Function parameters
 * @param {string} params.githubUsername - GitHub username to look up (e.g., "octocat")
 * @param {string} params.slackToken - Slack bot token with users:read scope
 * @param {string} [params.userMapping] - Optional JSON string mapping GitHub username to Slack user ID
 *                                         Example: '{"octocat": "U12345678"}'
 * @param {GitHubAPIClient} params.github - GitHub API client from actions/github-script
 * @param {CoreUtilities} params.core - Core utilities from actions/github-script
 * @returns {Promise<SlackUser|null>} Slack user object or null if not found
 */
async function findSlackUser({ githubUsername, slackToken, userMapping, github, core }) {
  try {
    let slackUser = null;

    // 1. First check manual user mapping
    if (userMapping) {
      try {
        const mapping = JSON.parse(userMapping);
        const slackUserId = mapping[githubUsername];

        if (slackUserId) {
          const userResponse = await fetch(`https://slack.com/api/users.info?user=${slackUserId}`, {
            headers: { 'Authorization': `Bearer ${slackToken}` }
          });
          const userData = await userResponse.json();

          if (userData.ok && userData.user) {
            core.info(`✓ Matched ${githubUsername} via manual mapping`);
            return userData.user;
          }
        }
      } catch (err) {
        core.warning(`Failed to parse user mapping: ${err.message}`);
      }
    }

    // 2. Get GitHub user info for fallback methods
    const { data: githubUser } = await github.rest.users.getByUsername({
      username: githubUsername
    });

    // 3. Try email lookup
    if (githubUser.email) {
      try {
        const emailResponse = await fetch('https://slack.com/api/users.lookupByEmail', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${slackToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email: githubUser.email })
        });
        const emailData = await emailResponse.json();

        if (emailData.ok && emailData.user) {
          core.info(`✓ Matched ${githubUsername} by email`);
          return emailData.user;
        }
      } catch (err) {
        core.warning(`Email lookup failed: ${err.message}`);
      }
    }

    // 4. Fallback: Search by name
    const listResponse = await fetch('https://slack.com/api/users.list', {
      headers: { 'Authorization': `Bearer ${slackToken}` }
    });
    const listData = await listResponse.json();

    if (listData.ok && listData.members) {
      const githubName = githubUser.name || githubUser.login;
      slackUser = listData.members.find(member =>
        !member.deleted && !member.is_bot &&
        (member.real_name?.toLowerCase().includes(githubName.toLowerCase()) ||
         member.profile?.display_name?.toLowerCase().includes(githubName.toLowerCase()) ||
         member.name?.toLowerCase() === githubUsername.toLowerCase())
      );

      if (slackUser) {
        core.info(`✓ Matched ${githubUsername} by name`);
        return slackUser;
      }
    }

    core.warning(`Could not find Slack user for ${githubUsername}`);
    return null;
  } catch (err) {
    core.warning(`Failed to lookup ${githubUsername}: ${err.message}`);
    return null;
  }
}

/**
 * Get Slack user profile data (username and avatar)
 *
 * Extracts the display name and best quality avatar from a Slack user object.
 * Avatar selection priority: original > 512px > 192px > 72px
 *
 * @param {SlackUser|null} slackUser - Slack user object from findSlackUser()
 * @returns {SlackUserProfile} Profile data ready for Slack API chat.postMessage
 * @example
 * const slackUser = await findSlackUser({ githubUsername: "octocat", ... });
 * const profile = getSlackUserProfile(slackUser);
 * // profile = { username: "Octo Cat", icon_url: "https://...", matched: true }
 */
function getSlackUserProfile(slackUser) {
  if (!slackUser) {
    return { username: '', icon_url: '', matched: false };
  }

  const displayName = slackUser.profile?.display_name || slackUser.real_name || slackUser.name;
  const avatar = slackUser.profile?.image_original ||
                 slackUser.profile?.image_512 ||
                 slackUser.profile?.image_192 ||
                 slackUser.profile?.image_72;

  return {
    username: displayName,
    icon_url: avatar,
    matched: true
  };
}

/**
 * Process @mentions in text and convert them to Slack user tags
 *
 * Scans text for GitHub-style @mentions (e.g., "@octocat") and converts them to
 * Slack user tags (e.g., "<@U12345678>") so mentioned users receive notifications.
 *
 * @param {Object} params - Function parameters
 * @param {string} params.text - Text containing GitHub @mentions
 * @param {string} params.slackToken - Slack bot token with users:read scope
 * @param {string} [params.userMapping] - Optional JSON string mapping GitHub username to Slack user ID
 * @param {GitHubAPIClient} params.github - GitHub API client from actions/github-script
 * @param {CoreUtilities} params.core - Core utilities from actions/github-script
 * @returns {Promise<string>} Text with @mentions converted to Slack tags
 * @example
 * const text = "Hey @octocat, can you review this?";
 * const processed = await processMentions({ text, slackToken, ... });
 * // processed = "Hey <@U12345678>, can you review this?"
 */
async function processMentions({ text, slackToken, userMapping, github, core }) {
  const mentionPattern = /@([a-zA-Z0-9-]+)/g;
  const mentions = [...text.matchAll(mentionPattern)];
  let processedText = text;

  if (mentions.length > 0) {
    core.info(`Found ${mentions.length} mention(s): ${mentions.map(m => m[1]).join(', ')}`);

    for (const match of mentions) {
      const githubUsername = match[1];
      const slackUser = await findSlackUser({
        githubUsername,
        slackToken,
        userMapping,
        github,
        core
      });

      if (slackUser) {
        processedText = processedText.replace(
          new RegExp(`@${githubUsername}\\b`, 'g'),
          `<@${slackUser.id}>`
        );
        core.info(`✓ Tagged ${githubUsername} as <@${slackUser.id}>`);
      }
    }
  }

  return processedText;
}

/**
 * Fetch review comments for a PR review (line-level comments)
 *
 * When a PR review is submitted without a body comment but with line-level comments,
 * this function retrieves those comments and combines them into a single string.
 * This ensures line comments are included in Slack notifications.
 *
 * @param {Object} params - Function parameters
 * @param {number|string} params.reviewId - GitHub review ID
 * @param {number|string} params.prNumber - Pull request number
 * @param {GitHubAPIClient} params.github - GitHub API client from actions/github-script
 * @param {GitHubContext} params.context - GitHub Actions context with repo info
 * @param {CoreUtilities} params.core - Core utilities from actions/github-script
 * @returns {Promise<string>} Combined comment bodies separated by double newlines, or empty string
 * @example
 * const reviewBody = await fetchReviewComments({
 *   reviewId: 123,
 *   prNumber: 456,
 *   github,
 *   context,
 *   core
 * });
 * // reviewBody = "Comment 1\n\nComment 2\n\nComment 3"
 */
async function fetchReviewComments({ reviewId, prNumber, github, context, core }) {
  try {
    const { data: comments } = await github.rest.pulls.listCommentsForReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      review_id: reviewId
    });

    if (comments && comments.length > 0) {
      core.info(`✓ Fetched ${comments.length} review comment(s)`);
      return comments.map(c => c.body).filter(Boolean).join('\n\n');
    }
  } catch (err) {
    core.warning(`Failed to fetch review comments: ${err.message}`);
  }

  return '';
}

/**
 * @typedef {Object} SlackBlock
 * @property {string} type - Block type (e.g., "section", "context")
 * @property {Object} [text] - Text content
 * @property {Array} [elements] - Context elements
 */

/**
 * @typedef {Object} ImageExtractionResult
 * @property {string} textWithoutImages - Text with image tags removed
 * @property {SlackBlock[]} imageBlocks - Array of Slack image blocks
 */

/**
 * Extract HTML image tags and convert them to Slack image blocks
 *
 * Scans text for HTML <img> tags and extracts them to create Slack image blocks.
 * Returns the text with images removed and an array of image blocks.
 *
 * @param {string} text - Text containing HTML image tags
 * @returns {ImageExtractionResult} Object with cleaned text and image blocks
 * @example
 * const result = extractAndConvertImages('Check this: <img src="https://example.com/image.png" alt="Test" />');
 * // result.textWithoutImages = "Check this:"
 * // result.imageBlocks = [{ type: "image", image_url: "https://example.com/image.png", alt_text: "Test" }]
 */
function extractAndConvertImages(text) {
  const imageBlocks = [];

  // Match HTML img tags (both self-closing and with closing tag)
  const imgTagPattern = /<img\s+[^>]*\/?>/gi;
  const matches = text.match(imgTagPattern) || [];

  for (const imgTag of matches) {
    // Extract src attribute
    const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
    // Extract alt attribute (optional)
    const altMatch = imgTag.match(/alt=["']([^"']+)["']/i);

    if (srcMatch && srcMatch[1]) {
      imageBlocks.push({
        type: 'image',
        image_url: srcMatch[1],
        alt_text: altMatch ? altMatch[1] : 'Image'
      });
    }
  }

  // Remove all img tags from text and trim extra whitespace
  const textWithoutImages = text
    .replace(imgTagPattern, '')
    .replace(/\n{3,}/g, '\n\n') // Replace multiple newlines with max 2
    .trim();

  return {
    textWithoutImages,
    imageBlocks
  };
}

/**
 * Build Slack message blocks for a PR comment notification
 *
 * @param {Object} params - Function parameters
 * @param {string} params.commentBody - Comment text (already processed for mentions)
 * @param {string} params.issueUrl - URL to the PR
 * @param {string} params.issueTitle - PR title
 * @param {string} params.commentUrl - URL to the specific comment
 * @param {string} params.commentAuthor - GitHub username of comment author
 * @returns {SlackBlock[]} Array of Slack block objects
 */
function buildCommentBlocks({ commentBody, issueUrl, issueTitle, commentUrl, commentAuthor }) {
  const blocks = [];

  // Extract images from comment body
  const { textWithoutImages, imageBlocks } = extractAndConvertImages(commentBody);

  // Only add section if there's actual content
  if (textWithoutImages) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: textWithoutImages
      }
    });
  }

  // Add image blocks
  blocks.push(...imageBlocks);

  // Context section
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<${issueUrl}|${issueTitle}> • <${commentUrl}|View comment> • ${commentAuthor}`
      }
    ]
  });

  return blocks;
}

/**
 * Build Slack message blocks for a review request notification
 *
 * @param {Object} params - Function parameters
 * @param {string} params.reviewerTag - Slack user tag (e.g., "<@U12345678>") or GitHub username
 * @param {string} params.prUrl - URL to the PR
 * @param {string} params.prTitle - PR title
 * @param {string} params.prBody - PR description
 * @param {string} params.prNumber - PR number
 * @param {string} params.requestSender - GitHub username of person who requested review
 * @param {string} params.requestedReviewer - GitHub username of requested reviewer
 * @returns {SlackBlock[]} Array of Slack block objects
 */
function buildReviewRequestBlocks({ reviewerTag, prUrl, prTitle, prBody, prNumber, requestSender, requestedReviewer }) {
  const blocks = [];

  // Extract images from PR body
  const { textWithoutImages, imageBlocks } = extractAndConvertImages(prBody.trim());

  // Main section with PR details
  const descriptionText = textWithoutImages ? `\n${textWithoutImages}` : '';
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `New PR review requested to ${reviewerTag}\n*<${prUrl}|${prTitle}>*${descriptionText}`
    }
  });

  // Add image blocks
  blocks.push(...imageBlocks);

  // Context section
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<${prUrl}|#${prNumber}> • ${requestSender} requested review from ${requestedReviewer}`
      }
    ]
  });

  return blocks;
}

/**
 * Build Slack message blocks for a PR review notification
 *
 * @param {Object} params - Function parameters
 * @param {string} params.reviewEmoji - Emoji representing review state (e.g., "✅", "💭", "🔄")
 * @param {string} params.reviewAction - Review action text (e.g., "Approved", "Commented")
 * @param {string} params.reviewBody - Review comment text (already processed for mentions)
 * @param {string} params.prUrl - URL to the PR
 * @param {string} params.prTitle - PR title
 * @param {string} params.reviewUrl - URL to the review
 * @param {string} params.reviewer - GitHub username of reviewer
 * @returns {SlackBlock[]} Array of Slack block objects
 */
function buildReviewBlocks({ reviewEmoji, reviewAction, reviewBody, prUrl, prTitle, reviewUrl, reviewer }) {
  const blocks = [];

  // Extract images from review body
  const { textWithoutImages, imageBlocks } = extractAndConvertImages(reviewBody);

  // Main section with emoji and action
  const mainText = textWithoutImages
    ? `${reviewEmoji} *${reviewAction}*\n${textWithoutImages}`
    : `${reviewEmoji} *${reviewAction}*`;

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: mainText
    }
  });

  // Add image blocks
  blocks.push(...imageBlocks);

  // Context section
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `<${prUrl}|${prTitle}> • <${reviewUrl}|View review> • ${reviewer}`
      }
    ]
  });

  return blocks;
}

// Export functions for use in GitHub Actions
module.exports = {
  findSlackUser,
  getSlackUserProfile,
  processMentions,
  fetchReviewComments,
  extractAndConvertImages,
  buildCommentBlocks,
  buildReviewRequestBlocks,
  buildReviewBlocks
};
