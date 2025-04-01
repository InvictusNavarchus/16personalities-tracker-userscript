// ==UserScript==
// @name         16Personalities Answer & Result Tracker
// @namespace    http://tampermonkey.net/
// @version      0.4.0
// @description  Tracks 16Personalities test answers and results, sending them to a server using event delegation.
// @author       Invictus
// @match        https://www.16personalities.com/free-personality-test*
// @match        https://www.16personalities.com/profiles/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=16personalities.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_log
// @connect      https://16personalities-tracker-backend.vercel.app/api/log-answers
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    // IMPORTANT: Replace this with the actual URL of your Vercel deployment
    const VERCEL_ENDPOINT = 'https://16personalities-tracker-backend.vercel.app/api/log-answers';
    const SESSION_ID_KEY = 'personalityTrackerCurrentSessionId'; // Key for storing session ID temporarily between test and results page

    // --- Helper Functions ---
    function getOrCreateUserId() {
        let userId = GM_getValue('personalityTrackerUserId', null);
        if (!userId) {
            // Use built-in crypto.randomUUID()
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                userId = crypto.randomUUID();
                GM_setValue('personalityTrackerUserId', userId);
                GM_log('Created new User ID using crypto.randomUUID():', userId);
            } else {
                // Fallback if crypto.randomUUID is somehow not available (very unlikely in modern browsers)
                console.error("crypto.randomUUID() is not available. Cannot generate user ID.");
                GM_log("Error: crypto.randomUUID() is not available.");
                // You might want to implement a simpler Math.random based generator here as a last resort
                // but it won't be a true UUID. For now, we'll just log an error.
                return null; // Indicate failure
            }
        }
        return userId;
    }

    // Renamed: Generates a *new* session ID. Used when starting a test.
    function generateNewSessionId() {
         if (typeof crypto !== 'undefined' && crypto.randomUUID) {
             return crypto.randomUUID();
         } else {
             console.error("crypto.randomUUID() is not available. Cannot generate session ID.");
             GM_log("Error: crypto.randomUUID() is not available.");
             return null; // Indicate failure
         }
    }

    // --- Main Logic ---
    const userId = getOrCreateUserId();
    let sessionId = null; // Will be determined based on page type (test start vs result view)

    // Function to send data to the server (now supports sendBeacon)
    async function sendData(payload, useBeacon = false) {
        // Make sure we have IDs before sending - Added safety check
        if (!payload.userId || !payload.sessionId) {
             GM_log("Cannot send data: Missing userId or sessionId in payload.", payload);
             return;
        }

        const dataStr = JSON.stringify(payload);
        // New log differentiating send method
        GM_log(`Attempting to send data (useBeacon: ${useBeacon}):`, payload);

        // New branch: Use sendBeacon if requested and available
        if (useBeacon && navigator.sendBeacon) {
            try {
                const blob = new Blob([dataStr], { type: 'application/json' });
                const success = navigator.sendBeacon(VERCEL_ENDPOINT, blob);
                if (success) {
                    GM_log('Data successfully queued using sendBeacon.');
                } else {
                    console.error('navigator.sendBeacon queuing failed.');
                    GM_log('Error: navigator.sendBeacon queuing failed.');
                }
            } catch (error) {
                console.error('Error using navigator.sendBeacon:', error);
                GM_log('Error using sendBeacon:', error.message);
            }
        } else {
            // Original fetch logic (with keepalive hint added)
            GM_log('Using fetch to send data...');
            try {
                const response = await fetch(VERCEL_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: dataStr,
                    keepalive: useBeacon, // keepalive is a hint for fetch, less reliable than sendBeacon for unload
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
                }

                const result = await response.json();
                GM_log('Data sent successfully via fetch:', result);
            } catch (error) {
                console.error('Error sending data via fetch:', error);
                GM_log('Error sending data via fetch:', error.message);
            }
        }
    }

    // --- Test Page Logic ---
    function handleTestPage() {
        // Ensure we have a user ID before proceeding on test page
        if (!userId) {
            GM_log("Could not get User ID. Tracker will not run on test page.");
            return;
        }
        sessionId = generateNewSessionId(); // Generate a fresh session ID for a new test
        if (!sessionId) {
            GM_log("Could not generate Session ID. Tracker will not run on test page.");
            return;
        }

        // Store the session ID to be retrieved on the results page
        GM_setValue(SESSION_ID_KEY, sessionId);
        GM_log(`Personality Test Tracker Initialized. User ID: ${userId}, Session ID: ${sessionId} (stored)`); // Updated log

        // Function to check if it's the very first page (all inputs unchecked)
        function isFirstPageUnanswered() {
             const firstQuestionExists = !!document.querySelector('fieldset[data-question="0"]');
             if (!firstQuestionExists) return false;

             const anyAnswerChecked = !!document.querySelector('form[data-quiz] input[type="radio"]:checked');
             return !anyAnswerChecked;
        }

        // --- Attach Listener using Event Delegation ---
        // Attach the listener to a stable ancestor like document.body.
        document.body.addEventListener('mousedown', async (event) => {
            // Target the specific button using its selector within the event handler
            const actionButtonSelector = 'div.action-row > button.sp-action';
            // Use event.target.closest() to check if the clicked element *is* the button
            // or is *inside* the button (e.g., clicking the text span)
            const actionButton = event.target.closest(actionButtonSelector);

            // If the click wasn't on our button or inside it, ignore the event
            if (!actionButton) {
                return;
            }

            // --- If we get here, the correct button was clicked ---
            // Use mousedown to capture before the page potentially unloads/changes
            GM_log('Action button clicked (via delegation). Extracting data...');

            // --- 1. Extract Answers (Same as before) ---
            const questions = document.querySelectorAll('form[data-quiz] fieldset.question');
            const answersData = [];
            const timestamp = new Date().toISOString(); // Timestamp for the answers batch

            questions.forEach(fieldset => {
                const questionNumber = fieldset.dataset.question;
                const questionTextElement = fieldset.querySelector('.statement span.header');
                const questionText = questionTextElement ? questionTextElement.textContent.trim() : 'Question text not found';
                const checkedInput = fieldset.querySelector('input[type="radio"]:checked');

                if (checkedInput) {
                    answersData.push({
                        question_number: parseInt(questionNumber, 10),
                        question_text: questionText,
                        answer_value: checkedInput.value,
                        answer_label: checkedInput.getAttribute('aria-label') || 'Label not found'
                    });
                } else {
                    GM_log(`Warning: No answer found for question ${questionNumber}`);
                    answersData.push({
                        question_number: parseInt(questionNumber, 10),
                        question_text: questionText,
                        answer_value: null, // Explicitly null
                        answer_label: 'Not Answered'
                    });
                }
            });

            const answersPayload = answersData.length > 0 ? {
                type: 'answers',
                userId: userId,
                sessionId: sessionId, // Use current session ID for this test
                timestamp: timestamp, // Use the timestamp generated for this batch
                answers: answersData
            } : null;

            // --- 2. Check if it's the "See results" button ---
            // Check based on aria-label or button text content for robustness
            const isSeeResultsButton = actionButton.getAttribute('aria-label')?.includes('Submit the test and see results') ||
                                     actionButton.querySelector('.button__text')?.textContent.trim() === 'See results';

            if (isSeeResultsButton) {
                GM_log('Detected "See results" button click.');

                // Send final answers using sendBeacon (fire and forget)
                if (answersPayload) {
                    GM_log('Sending final answers payload (using sendBeacon)...');
                    sendData(answersPayload, true); // Use sendBeacon, no await
                } else {
                    GM_log('No final answers found on this page click.');
                }

                // Send finish event using sendBeacon (fire and forget)
                GM_log('Sending finish event payload (using sendBeacon)...');
                const finishPayload = {
                    type: 'event',
                    eventName: 'test_finished',
                    userId: userId,
                    sessionId: sessionId, // Use current session ID for this test
                    timestamp: new Date().toISOString(), // Generate a fresh timestamp for the event itself
                };
                sendData(finishPayload, true); // Use sendBeacon, do not await
                // NOTE: Session ID remains stored via GM_setValue for the results page to retrieve

            } else {
                // --- Original logic for "Next" button ---
                // Send answers normally using fetch
                if (answersPayload) {
                    GM_log('Sending answers payload for "Next" click...');
                    // Send data, but DO NOT preventDefault. Let Vue handle the transition.
                    sendData(answersPayload, false); // Send answers first, using fetch
                } else {
                    GM_log('No answers found on this page click.');
                }
                // Let the default action proceed for the "Next" button (load next questions)
                // IMPORTANT: No event.preventDefault() here for the 'Next' button.
            }
        }); // End of event delegation listener

        // --- Initial Start Event Logic ---
        // Add listener after a short delay OR on load to check for the first page.
        window.addEventListener('load', () => {
            // Check for first arrival
            if (isFirstPageUnanswered()) {
                GM_log('Detected first page visit (unanswered). Sending start event.');
                const startPayload = {
                    type: 'event',
                    eventName: 'test_started',
                    userId: userId,
                    sessionId: sessionId, // Use current session ID for this test
                    timestamp: new Date().toISOString(),
                };
                sendData(startPayload); // Send start event normally
            }
            // Log confirmation that the main listener is active
            GM_log("Event delegation listener attached to document body for test page."); // Updated log
        });
    }

    // --- Results Page Logic --- // New section
    function handleResultsPage() {
        // Ensure we have a user ID before proceeding on results page
        if (!userId) {
            GM_log("User ID missing on results page. Cannot log results.");
            return;
        }
        // Retrieve the session ID stored from the test page
        sessionId = GM_getValue(SESSION_ID_KEY, null);
        if (!sessionId) {
             GM_log("Session ID missing on results page (was test completed with tracker active?). Cannot link results to session.");
             // Decide if you want to log results without a session ID or stop.
             // For now, we stop if session ID is missing, as linking is desired.
             return;
        }

        GM_log(`Results Page Tracker Initialized. User ID: ${userId}, Session ID: ${sessionId} (retrieved)`); // New log

        // Function to extract results data from the page
        function extractResultData() {
            const resultData = {
                mbtiResult: null, // e.g. "Defender (ISFJ-A)"
                mbtiCode: null,   // e.g. "ISFJ-A"
                profileUrl: window.location.href,
                traits: {
                    mind: { percent: null, type: null },
                    energy: { percent: null, type: null },
                    nature: { percent: null, type: null },
                    tactics: { percent: null, type: null },
                    identity: { percent: null, type: null },
                }
            };

            // Extract MBTI Result (e.g., "Defender (ISFJ-A)")
            const titleElement = document.querySelector('h1.header__title'); // Selector based on provided HTML
            if (titleElement) {
                resultData.mbtiResult = titleElement.textContent.trim();
                 // Optional: Clean up to get just "ISFJ-A" if needed
                 const match = resultData.mbtiResult.match(/\(([^)]+)\)/);
                 if (match && match[1]) {
                     resultData.mbtiCode = match[1]; // e.g., ISFJ-A
                 }
            } else {
                 GM_log("Warning: Could not find MBTI result title element (h1.header__title).");
            }


            // Extract Trait Percentages
            // Uses selectors based on the provided HTML structure for the traits section
            const traitBoxes = document.querySelectorAll('div.sp-card--traits .traitbox');
            traitBoxes.forEach(box => {
                const textElement = box.querySelector('.traitbox__text'); // Contains "Energy: 51% Introverted"
                if (!textElement) return;

                const textContent = textElement.textContent.trim();
                const labelMatch = textContent.match(/^(\w+):/); // e.g., "Energy:"
                const percentMatch = textContent.match(/(\d+)%/); // e.g., "51%"
                // This regex is slightly more robust to capture the type after the percentage
                const typeMatch = textContent.match(/\d+%\s*([\w\s]+)/); // e.g., " Introverted" -> "Introverted"

                if (labelMatch && percentMatch && typeMatch) {
                    const traitName = labelMatch[1].toLowerCase(); // e.g., 'energy'
                    const percent = parseInt(percentMatch[1], 10);
                    let type = typeMatch[1].trim(); // e.g., 'Introverted'

                    if (resultData.traits.hasOwnProperty(traitName)) {
                         resultData.traits[traitName].percent = percent;
                         resultData.traits[traitName].type = type;
                         // GM_log(`Extracted Trait: ${traitName}, Percent: ${percent}, Type: ${type}`); // Optional detailed log
                    } else {
                         GM_log(`Warning: Found unknown trait label '${labelMatch[1]}' in trait box.`);
                    }
                } else {
                     GM_log("Warning: Could not parse trait data from text:", textContent);
                }
            });
            GM_log("Finished extracting trait data.", resultData.traits);
            return resultData;
        }

        // Send results data on page load for the results page
        window.addEventListener('load', () => {
            GM_log('Results page loaded. Extracting and sending results...');
            const resultData = extractResultData();

            // Basic check if extraction was successful before sending
            if (!resultData.mbtiResult || !resultData.mbtiCode || Object.values(resultData.traits).some(t => t.percent === null)) {
                GM_log("Error: Failed to extract complete result data. Aborting send. Session ID kept for potential retry/debugging.", resultData);
                // Do not delete session ID here if sending failed, might be useful to keep it
                return;
            }

            // Prepare the payload for the result type
            const resultPayload = {
                type: 'result', // New type for backend
                userId: userId,
                sessionId: sessionId, // Use the retrieved session ID
                timestamp: new Date().toISOString(),
                profileUrl: resultData.profileUrl,
                mbtiResult: resultData.mbtiResult, // Full result like "Defender (ISFJ-A)"
                mbtiCode: resultData.mbtiCode,     // Just the code "ISFJ-A"
                traits: resultData.traits         // Object with mind, energy, etc. details
            };

            sendData(resultPayload, false); // Send results using fetch (beacon not necessary here)

            // Clean up the stored session ID *after* attempting to send
            // Prevents trying to send results multiple times on refresh if send fails
            GM_deleteValue(SESSION_ID_KEY);
            GM_log("Result data send attempted. Cleared session ID from storage.");
        });
    }

    // --- Router: Decide which logic to run based on URL --- // New section
    if (!userId) {
        GM_log("Could not get or create User ID. Tracker cannot run.");
    } else if (window.location.href.includes('/free-personality-test')) {
        handleTestPage();
    } else if (window.location.href.includes('/profiles/')) {
        handleResultsPage();
    } else {
        GM_log("Script loaded on an unrecognized 16Personalities page.");
    }

})();