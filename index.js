// ==UserScript==
// @name         16Personalities Answer Tracker
// @namespace    http://tampermonkey.net/
// @version      0.1.1
// @description  Tracks 16Personalities test answers and sends them to a server.
// @author       Invictus
// @match        https://www.16personalities.com/free-personality-test*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=16personalities.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_log
// @connect      https://16personalities-tracker-backend.vercel.app/api/log-answers  // <-- IMPORTANT: Replace with your Vercel URL
// @require      https://cdnjs.cloudflare.com/ajax/libs/uuid/8.3.2/uuid.min.js // For generating UUIDs
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
            userId = uuid.v4(); // Generate UUID using the @require library
            GM_setValue('personalityTrackerUserId', userId);
            GM_log('Created new User ID:', userId);
        }
        return userId;
    }

    // --- Main Logic ---
    const userId = getOrCreateUserId();
    const sessionId = uuid.v4(); // New session ID for each test attempt/page load

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
            // Optionally clear or update local storage backup here
        } catch (error) {
            console.error('Error sending data:', error);
            GM_log('Error sending data:', error.message);
            // Consider saving failed payloads to localStorage for retry later
            // GM_setValue('failedPayloads', JSON.stringify([...JSON.parse(GM_getValue('failedPayloads', '[]')), payload]));
        }
    }

     // Function to check if it's the very first page (all inputs unchecked)
    function isFirstPageUnanswered() {
        const firstQuestionExists = !!document.querySelector('fieldset[data-question="0"]');
        if (!firstQuestionExists) return false; // Not the first page structure

        const anyAnswerChecked = !!document.querySelector('form[data-quiz] input[type="radio"]:checked');
        return !anyAnswerChecked; // It's the first page AND unanswered if no radio is checked
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
             sendData(startPayload); // Send the start event log
        }


        const nextButton = document.querySelector('button.sp-action[aria-label="Go to next set of questions"]');

        if (nextButton) {
            GM_log('Next button found. Attaching listener.');
            // Use 'mousedown' as it fires before 'click' and navigation might interrupt 'click'
            nextButton.addEventListener('mousedown', (event) => {
                GM_log('Next button clicked. Extracting data...');

                const questions = document.querySelectorAll('form[data-quiz] fieldset.question');
                const answersData = [];
                const timestamp = new Date().toISOString();

                questions.forEach(fieldset => {
                    const questionNumber = fieldset.dataset.question;
                    const questionTextElement = fieldset.querySelector('.statement span.header');
                    // Handle cases where the structure might slightly differ or elements are missing
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
                         // This case should ideally not happen if the button requires all answers
                         GM_log(`Warning: No answer found for question ${questionNumber}`);
                         answersData.push({
                            question_number: parseInt(questionNumber, 10),
                            question_text: questionText,
                            answer_value: null,
                            answer_label: 'Not Answered'
                        });
                    }
                });

                if (answersData.length > 0) {
                    const payload = {
                        type: 'answers',
                        userId: userId,
                        sessionId: sessionId,
                        timestamp: timestamp,
                        answers: answersData
                    };
                    // Send data asynchronously, don't wait for it as page navigates away
                    sendData(payload);

                    // Optional: Save to localStorage as a backup (implement appending logic if needed)
                    // try {
                    //     localStorage.setItem(`16p_answers_${sessionId}_${Date.now()}`, JSON.stringify(payload));
                    // } catch (e) {
                    //     GM_log('Error saving backup to localStorage:', e);
                    // }

                } else {
                    GM_log('No answers found on this page click.');
                }

                // We don't prevent default, let the navigation proceed
            });
        } else {
            GM_log('Next button not found on this page.');
        }
    });

})();