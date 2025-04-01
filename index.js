// ==UserScript==
// @name           16Personalities Answer Tracker
// @namespace      http://tampermonkey.net/
// @version        0.3.1
// @description    Tracks 16Personalities test answers and sends them to a server using event delegation.
// @author         Invictus (with integration assistance)
// @match          https://www.16personalities.com/free-personality-test*
// @icon           https://www.google.com/s2/favicons?sz=64&domain=16personalities.com
// @grant          GM_setValue
// @grant          GM_getValue
// @grant          GM_log
// @connect        https://16personalities-tracker-backend.vercel.app/api/log-answers  // <-- IMPORTANT: Replace with your Vercel URL
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    // IMPORTANT: Replace this with the actual URL of your Vercel deployment
    const VERCEL_ENDPOINT = 'https://16personalities-tracker-backend.vercel.app/api/log-answers';
    // ---------------------

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

    function generateSessionId() {
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
    // Generate a new session ID only if we successfully got a user ID
    const sessionId = userId ? generateSessionId() : null;

    // Proceed only if we have valid IDs
    if (!userId || !sessionId) {
        GM_log("Could not generate required IDs. Tracker will not run.");
        return; // Stop script execution if IDs couldn't be generated
    }

    GM_log(`Personality Tracker Initialized. User ID: ${userId}, Session ID: ${sessionId}`);

    // Function to send data to the server (now supports sendBeacon)
    async function sendData(payload, useBeacon = false) { // Added useBeacon parameter
        const dataStr = JSON.stringify(payload);
        // New log differentiating send method
        GM_log(`Attempting to send data (useBeacon: ${useBeacon}):`, payload);

        // New branch: Use sendBeacon if requested and available
        if (useBeacon && navigator.sendBeacon) {
            try {
                const blob = new Blob([dataStr], { type: 'application/json' });
                const success = navigator.sendBeacon(VERCEL_ENDPOINT, blob);
                if (success) {
                    GM_log('Data successfully queued using sendBeacon.'); // New log message
                } else {
                    console.error('navigator.sendBeacon queuing failed.');
                    GM_log('Error: navigator.sendBeacon queuing failed.'); // New log message
                }
            } catch (error) {
                console.error('Error using navigator.sendBeacon:', error);
                GM_log('Error using sendBeacon:', error.message); // New log message
            }
        } else {
            // Original fetch logic (with keepalive hint added)
            GM_log('Using fetch to send data...'); // Added clarification log
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
                GM_log('Data sent successfully via fetch:', result); // Modified log slightly for context
            } catch (error) {
                console.error('Error sending data via fetch:', error); // Modified log slightly for context
                GM_log('Error sending data via fetch:', error.message); // Modified log slightly for context
            }
        }
    }

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
             sessionId: sessionId,
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
                 sessionId: sessionId,
                 timestamp: new Date().toISOString(), // Generate a fresh timestamp for the event itself
             };
             sendData(finishPayload, true); // Use sendBeacon, do not await

         } else {
             // --- Original logic for "Next" button ---
             // Send answers normally using fetch
             if (answersPayload) {
                 GM_log('Sending answers payload for "Next" click...');
                 // Send data, but DO NOT preventDefault. Let Vue handle the transition.
                 sendData(answersPayload, false); // Send answers first
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
                 sessionId: sessionId,
                 timestamp: new Date().toISOString(),
             };
             sendData(startPayload); // Send start event normally
         }
         // Log confirmation that the main listener is active
         GM_log("Event delegation listener attached to document body.");
     });

})();