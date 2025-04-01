// ==UserScript==
// @name         16Personalities Answer Tracker
// @namespace    http://tampermonkey.net/
// @version      0.2.0
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

    // Function to send data to the server
    async function sendData(payload) {
        GM_log('Attempting to send data:', payload);
        try {
            const response = await fetch(VERCEL_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
            }

            const result = await response.json();
            GM_log('Data sent successfully:', result);
        } catch (error) {
            console.error('Error sending data:', error);
            GM_log('Error sending data:', error.message);
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
             sendData(startPayload);
        }

        // Use a more general selector targeting the button within the action row
        const actionButton = document.querySelector('div.action-row > button.sp-action');

        if (actionButton) {
            GM_log('Action button (Next or See Results) found. Attaching listener.');

            actionButton.addEventListener('mousedown', (event) => {
                // Use mousedown to capture before the page potentially unloads/changes
                GM_log('Action button clicked. Extracting data...');

                // --- 1. Extract and Send Answers (Always do this on click) ---
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
                        // Log missing answer, but still include the question structure if needed
                        GM_log(`Warning: No answer found for question ${questionNumber}`);
                        answersData.push({
                            question_number: parseInt(questionNumber, 10),
                            question_text: questionText,
                            answer_value: null, // Explicitly null
                            answer_label: 'Not Answered'
                        });
                    }
                });

                if (answersData.length > 0) {
                    const answersPayload = {
                        type: 'answers',
                        userId: userId,
                        sessionId: sessionId,
                        timestamp: timestamp, // Use the timestamp generated for this batch
                        answers: answersData
                    };
                    GM_log('Sending answers payload...');
                    sendData(answersPayload); // Send answers first
                } else {
                    GM_log('No answers found on this page click.');
                }

                // --- 2. Check if it's the "See results" button and send finish event ---
                // Check based on aria-label or button text content for robustness
                const isSeeResultsButton = actionButton.getAttribute('aria-label')?.includes('Submit the test and see results') ||
                                           actionButton.querySelector('.button__text')?.textContent.trim() === 'See results';

                if (isSeeResultsButton) {
                    GM_log('Detected "See results" button click. Sending finish event.');
                    const finishPayload = {
                        type: 'event',
                        eventName: 'test_finished',
                        userId: userId,
                        sessionId: sessionId,
                        timestamp: new Date().toISOString(), // Generate a fresh timestamp for the event itself
                    };
                    GM_log('Sending finish event payload...');
                    sendData(finishPayload); // Send the finish event *after* sending the final answers
                }
            });
        } else {
            GM_log('Action button (Next/See Results) not found on this page load.');
            // You might want to add a MutationObserver here if the button loads dynamically
            // after the initial 'load' event, but for 16p, 'load' is usually sufficient.
        }
    });

})();