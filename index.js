// ==UserScript==
// @name         16Personalities Answer Tracker
// @namespace    http://tampermonkey.net/
// @version      0.2.2
// @description  Tracks 16Personalities test answers and sends them to a server.
// @author       Invictus
// @match        https://www.16personalities.com/free-personality-test*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=16personalities.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      https://16personalities-tracker-backend.vercel.app/api/log-answers  // <-- IMPORTANT: Replace with your Vercel URL
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

    // Add listener after a short delay to ensure the button is loaded
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

        // Use a more general selector targeting the button within the action row
        const actionButton = document.querySelector('div.action-row > button.sp-action');

        if (actionButton) {
            GM_log('Action button (Next or See Results) found. Attaching listener.');

            // Add async here to allow await inside the handler
            actionButton.addEventListener('mousedown', async (event) => {
                // Use mousedown to capture before the page potentially unloads/changes
                GM_log('Action button clicked. Extracting data...');

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

                    // --- NEW: Prevent the default navigation immediately ---
                    event.preventDefault();
                    GM_log('Prevented default button action.');

                    // --- NEW: Send final answers using fetch and await it ---
                    if (answersPayload) {
                        GM_log('Sending final answers payload (using fetch)...');
                        await sendData(answersPayload, false); // Use fetch, wait for it to attempt sending
                    } else {
                        GM_log('No final answers found on this page click.');
                    }

                    // --- NEW: Send finish event using sendBeacon (fire and forget) ---
                    GM_log('Sending finish event payload (using sendBeacon)...');
                    const finishPayload = {
                        type: 'event',
                        eventName: 'test_finished',
                        userId: userId,
                        sessionId: sessionId,
                        timestamp: new Date().toISOString(), // Generate a fresh timestamp for the event itself
                    };
                    sendData(finishPayload, true); // Use sendBeacon, do not await

                    // --- NEW: Manually trigger the form submission AFTER sending data ---
                    GM_log('Attempting to manually trigger form submission...');
                    const form = actionButton.closest('form');
                    if (form) {
                        // Use timeout to allow sendBeacon a slightly better chance, though it's technically asynchronous
                        setTimeout(() => {
                            form.submit();
                            GM_log('Form submitted manually.');
                         }, 100); // Small delay might help but isn't strictly necessary for sendBeacon
                    } else {
                        GM_log('Error: Could not find parent form to submit manually.');
                        // If form submission fails, you might need to redirect manually if you know the URL
                        // window.location.href = '...'; // Fallback if needed
                    }

                } else {
                    // --- Original logic for "Next" button ---
                    // Send answers normally using fetch
                    if (answersPayload) {
                        GM_log('Sending answers payload for "Next" click...');
                        sendData(answersPayload, false); // Send answers first
                    } else {
                        GM_log('No answers found on this page click.');
                    }
                    // Let the default action proceed for the "Next" button (load next questions)
                }
            });
        } else {
            GM_log('Action button (Next/See Results) not found on this page load.');
            // You might want to add a MutationObserver here if the button loads dynamically
            // after the initial 'load' event, but for 16p, 'load' is usually sufficient.
        }
    });

})();