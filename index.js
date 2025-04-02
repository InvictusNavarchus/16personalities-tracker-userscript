// ==UserScript==
// @name         16Personalities Answer & Result Tracker
// @namespace    http://tampermonkey.net/
// @version      0.4.3
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

    /**
     * Configuration constants
     */
    const CONFIG = {
        /** Endpoint for sending tracking data */
        VERCEL_ENDPOINT: 'https://16personalities-tracker-backend.vercel.app/api/log-answers',
        /** Storage key for temporary session ID */
        SESSION_ID_KEY: 'personalityTrackerCurrentSessionId',
        /** Storage key for persistent user ID */
        USER_ID_KEY: 'personalityTrackerUserId',
        /** Maximum attempts for polling the results page */
        MAX_POLLING_ATTEMPTS: 60,
        /** Interval between polling attempts in ms */
        POLLING_INTERVAL: 500
    };

    /**
     * Logger module for consistent logging
     */
    const Logger = {
        /**
         * Log informational message
         * @param {string} message - Message to log
         * @param {*} [data] - Optional data to include
         */
        info(message, data) {
            if (data !== undefined) {
                GM_log(message, data);
            } else {
                GM_log(message);
            }
        },
        
        /**
         * Log warning message
         * @param {string} message - Warning message to log
         * @param {*} [data] - Optional data to include
         */
        warn(message, data) {
            const warningMsg = `Warning: ${message}`;
            if (data !== undefined) {
                GM_log(warningMsg, data);
            } else {
                GM_log(warningMsg);
            }
        },
        
        /**
         * Log error message
         * @param {string} message - Error message to log
         * @param {*} [data] - Optional data to include
         */
        error(message, data) {
            const errorMsg = `Error: ${message}`;
            console.error(errorMsg, data);
            if (data !== undefined) {
                GM_log(errorMsg, data);
            } else {
                GM_log(errorMsg);
            }
        }
    };

    /**
     * User and session management module
     */
    const UserManager = {
        /**
         * Get existing user ID or create a new one
         * @returns {string|null} User ID or null if creation failed
         */
        getOrCreateUserId() {
            let userId = GM_getValue(CONFIG.USER_ID_KEY, null);
            if (!userId) {
                if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                    userId = crypto.randomUUID();
                    GM_setValue(CONFIG.USER_ID_KEY, userId);
                    Logger.info('Created new User ID using crypto.randomUUID():', userId);
                } else {
                    Logger.error("crypto.randomUUID() is not available. Cannot generate user ID.");
                    return null;
                }
            }
            return userId;
        },
        
        /**
         * Generate a new session ID for tracking a test session
         * @returns {string|null} New session ID or null if generation failed
         */
        generateNewSessionId() {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            } else {
                Logger.error("crypto.randomUUID() is not available. Cannot generate session ID.");
                return null;
            }
        },
        
        /**
         * Store session ID for later retrieval on results page
         * @param {string} sessionId - Session ID to store
         */
        storeSessionId(sessionId) {
            GM_setValue(CONFIG.SESSION_ID_KEY, sessionId);
        },
        
        /**
         * Get stored session ID from previous test page
         * @returns {string|null} Stored session ID or null if not found
         */
        getStoredSessionId() {
            return GM_getValue(CONFIG.SESSION_ID_KEY, null);
        },
        
        /**
         * Clear stored session ID
         */
        clearSessionId() {
            GM_deleteValue(CONFIG.SESSION_ID_KEY);
        }
    };

    /**
     * Data service for API communication
     */
    const DataService = {
        /**
         * Send data to the server
         * @param {Object} payload - Data payload to send
         * @param {boolean} useBeacon - Whether to use navigator.sendBeacon (for unload events)
         * @returns {Promise<Object|null>} Response data or null
         */
        async sendData(payload, useBeacon = false) {
            // Safety check for required fields
            if (!payload.userId || !payload.sessionId) {
                Logger.error("Cannot send data: Missing userId or sessionId in payload.", payload);
                return null;
            }

            const dataStr = JSON.stringify(payload);
            Logger.info(`Attempting to send data (useBeacon: ${useBeacon}):`, payload);

            // Use sendBeacon if requested and available (for unload events)
            if (useBeacon && navigator.sendBeacon) {
                try {
                    const blob = new Blob([dataStr], { type: 'application/json' });
                    const success = navigator.sendBeacon(CONFIG.VERCEL_ENDPOINT, blob);
                    if (success) {
                        Logger.info('Data successfully queued using sendBeacon.');
                        return { success: true };
                    } else {
                        Logger.error('navigator.sendBeacon queuing failed.');
                        return null;
                    }
                } catch (error) {
                    Logger.error(`Error using navigator.sendBeacon: ${error.message}`);
                    return null;
                }
            } else {
                // Use fetch for normal requests
                Logger.info('Using fetch to send data...');
                try {
                    const response = await fetch(CONFIG.VERCEL_ENDPOINT, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: dataStr,
                        keepalive: useBeacon, // keepalive hint for fetch
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! Status: ${response.status} - ${await response.text()}`);
                    }

                    const result = await response.json();
                    Logger.info('Data sent successfully via fetch:', result);
                    return result;
                } catch (error) {
                    Logger.error(`Error sending data via fetch: ${error.message}`);
                    return null;
                }
            }
        }
    };

    /**
     * Test page handler module
     */
    const TestPageHandler = {
        /** @type {string} User ID */
        userId: null,
        
        /** @type {string} Session ID */
        sessionId: null,
        
        /**
         * Initialize the test page handler
         * @param {string} userId - User ID
         * @param {string} sessionId - Session ID
         */
        initialize(userId, sessionId) {
            this.userId = userId;
            this.sessionId = sessionId;
            
            Logger.info(`Personality Test Tracker Initialized. User ID: ${userId}, Session ID: ${sessionId} (stored)`);
            
            // Attach event listener for button clicks
            this.attachEventListeners();
            
            // Check if we need to log test start event
            window.addEventListener('load', () => {
                if (this.isFirstPageUnanswered()) {
                    this.sendTestStartEvent();
                }
                Logger.info("Event delegation listener attached to document body for test page.");
            });
        },
        
        /**
         * Check if it's the first page with all inputs unchecked
         * @returns {boolean} True if first page is unanswered
         */
        isFirstPageUnanswered() {
            const firstQuestionExists = !!document.querySelector('fieldset[data-question="0"]');
            if (!firstQuestionExists) return false;

            const anyAnswerChecked = !!document.querySelector('form[data-quiz] input[type="radio"]:checked');
            return !anyAnswerChecked;
        },
        
        /**
         * Send test start event
         */
        sendTestStartEvent() {
            Logger.info('Detected first page visit (unanswered). Sending start event.');
            const startPayload = {
                type: 'event',
                eventName: 'test_started',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
            };
            DataService.sendData(startPayload);
        },
        
        /**
         * Attach event listeners for the test page
         */
        attachEventListeners() {
            document.body.addEventListener('mousedown', this.handleActionButtonClick.bind(this));
        },
        
        /**
         * Extract answers data from the current page
         * @returns {Array} Array of answer objects
         */
        extractAnswersData() {
            const questions = document.querySelectorAll('form[data-quiz] fieldset.question');
            const answersData = [];
            
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
                    Logger.warn(`No answer found for question ${questionNumber}`);
                    answersData.push({
                        question_number: parseInt(questionNumber, 10),
                        question_text: questionText,
                        answer_value: null,
                        answer_label: 'Not Answered'
                    });
                }
            });
            
            return answersData;
        },
        
        /**
         * Handle action button click event
         * @param {Event} event - Click event
         */
        handleActionButtonClick(event) {
            const actionButtonSelector = 'div.action-row > button.sp-action';
            const actionButton = event.target.closest(actionButtonSelector);
            
            // If not clicking the action button, return early
            if (!actionButton) {
                return;
            }
            
            Logger.info('Action button clicked (via delegation). Extracting data...');
            
            // Extract answers data
            const answersData = this.extractAnswersData();
            const timestamp = new Date().toISOString();
            
            // Create answers payload if we have answers
            const answersPayload = answersData.length > 0 ? {
                type: 'answers',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: timestamp,
                answers: answersData
            } : null;
            
            // Check if it's the "See results" button
            const isSeeResultsButton = actionButton.getAttribute('aria-label')?.includes('Submit the test and see results') ||
                                     actionButton.querySelector('.button__text')?.textContent.trim() === 'See results';
            
            if (isSeeResultsButton) {
                this.handleSeeResultsClick(answersPayload);
            } else {
                this.handleNextClick(answersPayload);
            }
        },
        
        /**
         * Handle "See results" button click
         * @param {Object|null} answersPayload - Answers payload
         */
        handleSeeResultsClick(answersPayload) {
            Logger.info('Detected "See results" button click.');
            
            // Send final answers using sendBeacon
            if (answersPayload) {
                Logger.info('Sending final answers payload (using sendBeacon)...');
                DataService.sendData(answersPayload, true);
            } else {
                Logger.info('No final answers found on this page click.');
            }
            
            // Send finish event using sendBeacon
            Logger.info('Sending finish event payload (using sendBeacon)...');
            const finishPayload = {
                type: 'event',
                eventName: 'test_finished',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
            };
            DataService.sendData(finishPayload, true);
        },
        
        /**
         * Handle "Next" button click
         * @param {Object|null} answersPayload - Answers payload
         */
        handleNextClick(answersPayload) {
            if (answersPayload) {
                Logger.info('Sending answers payload for "Next" click...');
                DataService.sendData(answersPayload, false);
            } else {
                Logger.info('No answers found on this page click.');
            }
            // Let the default action proceed for the "Next" button
        }
    };

    /**
     * Results page handler module
     */
    const ResultsPageHandler = {
        /** @type {string} User ID */
        userId: null,
        
        /** @type {string} Session ID */
        sessionId: null,
        
        /**
         * Initialize the results page handler
         * @param {string} userId - User ID
         * @param {string} sessionId - Session ID
         */
        initialize(userId, sessionId) {
            this.userId = userId;
            this.sessionId = sessionId;
            
            Logger.info(`Results Page Tracker Initialized. User ID: ${userId}, Session ID: ${sessionId} (retrieved)`);
            
            // Start polling for results content
            this.startPollingForResults();
        },
        
        /**
         * Start polling for results content
         */
        startPollingForResults() {
            let checkAttempts = 0;
            const resultsCheckInterval = setInterval(() => {
                checkAttempts++;
                if (this.isResultsContentLoaded()) {
                    clearInterval(resultsCheckInterval);
                    Logger.info(`Results content detected after ${checkAttempts} attempts (${checkAttempts * CONFIG.POLLING_INTERVAL / 1000}s)`);
                    this.handleResultsData();
                } else if (checkAttempts >= CONFIG.MAX_POLLING_ATTEMPTS) {
                    clearInterval(resultsCheckInterval);
                    Logger.warn(`Timed out waiting for results content after ${CONFIG.MAX_POLLING_ATTEMPTS * CONFIG.POLLING_INTERVAL / 1000} seconds.`);
                } else if (checkAttempts % 10 === 0) {
                    Logger.info(`Still waiting for results content... (${checkAttempts * CONFIG.POLLING_INTERVAL / 1000}s elapsed)`);
                }
            }, CONFIG.POLLING_INTERVAL);
        },
        
        /**
         * Check if results content is loaded
         * @returns {boolean} True if results content is loaded
         */
        isResultsContentLoaded() {
            const titleElementF1 = document.querySelector('h1.header__title');
            const titleElementF2 = document.querySelector('.sp-typeheader .h1-phone, .sp-typeheader .h1-large-lgbp');
            const codeElementF2 = document.querySelector('.sp-typeheader .code h1');
            const titleLoaded = !!titleElementF1 || (!!titleElementF2 && !!codeElementF2);
            const traitBoxes = document.querySelectorAll('.sp-card--traits .traitbox, .profile__traits--intl .traitbox');
            const traitsLoaded = traitBoxes.length >= 5;
            return titleLoaded && traitsLoaded;
        },
        
        /**
         * Handle results data extraction and sending
         */
        handleResultsData() {
            Logger.info('Results content detected. Extracting and sending results...');
            const resultData = this.extractResultData();
            
            // Validate that we extracted complete data
            if (!resultData.mbtiResult || !resultData.mbtiCode || Object.values(resultData.traits).some(t => t.percent === null || t.type === null)) {
                Logger.error("Failed to extract complete result data. Aborting send. Session ID kept for potential retry/debugging.", resultData);
                return;
            }
            
            const resultPayload = {
                type: 'result',
                userId: this.userId,
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
                profileUrl: resultData.profileUrl,
                mbtiResult: resultData.mbtiResult,
                mbtiCode: resultData.mbtiCode,
                traits: resultData.traits
            };
            
            DataService.sendData(resultPayload, false);
            UserManager.clearSessionId();
            Logger.info("Result data send attempted. Cleared session ID from storage.");
        },
        
        /**
         * Extract result data from the page
         * @returns {Object} Extracted result data
         */
        extractResultData() {
            const resultData = {
            mbtiResult: null, // Example: "Architect (INTJ-A)"
            mbtiCode: null,   // Example: "INTJ-A"
            profileUrl: window.location.href, // Example: "https://www.16personalities.com/profiles/12345"
            traits: {
                mind: { percent: null, type: null },    // Example: { percent: 75, type: "Introverted" }
                energy: { percent: null, type: null },  // Example: { percent: 60, type: "Intuitive" }
                nature: { percent: null, type: null },  // Example: { percent: 55, type: "Thinking" }
                tactics: { percent: null, type: null }, // Example: { percent: 70, type: "Judging" }
                identity: { percent: null, type: null } // Example: { percent: 80, type: "Assertive" }
            }
            };
            
            // Extract MBTI Result and Code
            this.extractMbtiData(resultData);
            
            // Extract trait percentages
            this.extractTraitPercentages(resultData);
            
            return resultData;
        },

        /**
         * Extract MBTI personality type and code
         * @param {Object} resultData - Result data object to populate
         */
        extractMbtiData(resultData) {
            // Try Format 1: Single h1 title with code in parentheses
            const titleElementF1 = document.querySelector('h1.header__title');
            if (titleElementF1) {
                resultData.mbtiResult = titleElementF1.textContent.trim();
                const match = resultData.mbtiResult.match(/\(([^)]+)\)/);
                if (match && match[1]) {
                    resultData.mbtiCode = match[1];
                }
                Logger.info("Extracted MBTI Result (Format 1)");
                return;
            }
            
            // Try Format 2: Separate title and code elements
            const titleElementF2 = document.querySelector('.sp-typeheader .h1-phone, .sp-typeheader .h1-large-lgbp');
            const codeElementF2 = document.querySelector('.sp-typeheader .code h1');
            if (titleElementF2 && codeElementF2) {
                const titleName = titleElementF2.textContent.trim();
                resultData.mbtiCode = codeElementF2.textContent.trim();
                resultData.mbtiResult = `${titleName} (${resultData.mbtiCode})`;
                Logger.info("Extracted MBTI Result (Format 2)");
                return;
            }
            
            Logger.warn("Could not find MBTI result title/code elements using known formats.");
        },
        
        /**
         * Extract trait percentages and populate resultData
         * @param {Object} resultData - Result data object to populate
         */
        extractTraitPercentages(resultData) {
            const traitContainer = document.querySelector('.sp-card--traits, .profile__traits--intl');
            if (!traitContainer) {
                Logger.warn("Could not find trait container element (.sp-card--traits or .profile__traits--intl).");
                return;
            }
            
            const traitBoxes = traitContainer.querySelectorAll('.traitbox');
            
            // Mapping for Format 2 color class -> trait name
            const colorToTraitMap = {
                'color--blue': 'energy',
                'color--yellow': 'mind',
                'color--green': 'nature',
                'color--purple': 'tactics',
                'color--red': 'identity',
                'text--blue': 'energy',
                'text--yellow': 'mind',
                'text--green': 'nature',
                'text--purple': 'tactics',
                'text--red': 'identity'
            };
            
            traitBoxes.forEach((box, index) => {
                let traitName = null;
                let percent = null;
                let type = null;
                let formatUsed = null;
                
                // Try Format 1 Structure
                const textElementF1 = box.querySelector('.traitbox__text');
                const labelElementF1 = textElementF1?.querySelector('.traitbox__label');
                const valueElementF1 = textElementF1?.querySelector('.traitbox__value');
                const percentSpanF1 = valueElementF1?.querySelector('span[class*="text--"]');
                
                if (textElementF1 && labelElementF1 && valueElementF1 && percentSpanF1) {
                    formatUsed = 1;
                    // Extract Trait Name
                    const labelMatch = labelElementF1.textContent.match(/^(\w+):/);
                    if (labelMatch) {
                        traitName = labelMatch[1].toLowerCase();
                    }
                    
                    // Extract Percent
                    const percentText = percentSpanF1.textContent.trim();
                    percent = parseInt(percentText.replace('%', ''), 10);
                    
                    // Extract Type
                    let foundPercentSpan = false;
                    for (let node of valueElementF1.childNodes) {
                        if (node === percentSpanF1) {
                            foundPercentSpan = true;
                        } else if (foundPercentSpan && node.nodeType === Node.TEXT_NODE) {
                            const potentialType = node.textContent.trim();
                            if (potentialType && /^[a-zA-Z\s]+$/.test(potentialType)) {
                                type = potentialType;
                                break;
                            }
                        }
                    }
                } else {
                    // Try Format 2 Structure
                    const percentStrongF2 = box.querySelector('.sp-barlabel strong[class*="color--"]');
                    if (percentStrongF2) {
                        formatUsed = 2;
                        // Extract Percent
                        const percentText = percentStrongF2.textContent.trim();
                        percent = parseInt(percentText.replace('%', ''), 10);
                        
                        // Extract Trait Name from color class
                        for (const className of percentStrongF2.classList) {
                            if (colorToTraitMap[className]) {
                                traitName = colorToTraitMap[className];
                                break;
                            }
                        }
                        
                        // Extract Type
                        const parentElement = percentStrongF2.parentNode;
                        if (parentElement) {
                            let foundPercentStrong = false;
                            for (let node of parentElement.childNodes) {
                                if (node === percentStrongF2) {
                                    foundPercentStrong = true;
                                } else if (foundPercentStrong && node.nodeType === Node.TEXT_NODE) {
                                    const potentialType = node.textContent.trim();
                                    if (potentialType && /^[a-zA-Z\s]+$/.test(potentialType)) {
                                        type = potentialType;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Assign to resultData if valid
                if (traitName && percent !== null && !isNaN(percent) && type && resultData.traits.hasOwnProperty(traitName)) {
                    resultData.traits[traitName].percent = percent;
                    resultData.traits[traitName].type = type;
                } else {
                    Logger.warn(`Could not reliably extract trait data for box index ${index}. Format Attempted: ${formatUsed || 'None'}. Data: Name=${traitName}, Percent=${percent}, Type=${type}`);
                }
            });
            
            Logger.info("Finished extracting trait data.", resultData.traits);
        }
    };

    /**
     * Initialize the script based on the current page
     */
    function initializeTracker() {
        const userId = UserManager.getOrCreateUserId();
        if (!userId) {
            Logger.error("Could not get or create User ID. Tracker cannot run.");
            return;
        }
        
        // Router logic to determine which page we're on
        if (window.location.href.includes('/free-personality-test')) {
            const sessionId = UserManager.generateNewSessionId();
            if (!sessionId) {
                Logger.error("Could not generate Session ID. Tracker will not run on test page.");
                return;
            }
            UserManager.storeSessionId(sessionId);
            TestPageHandler.initialize(userId, sessionId);
        } else if (window.location.href.includes('/profiles/')) {
            const sessionId = UserManager.getStoredSessionId();
            if (!sessionId) {
                Logger.warn("Session ID missing on results page (was test completed with tracker active?). Cannot link results to session.");
                return;
            }
            ResultsPageHandler.initialize(userId, sessionId);
        } else {
            Logger.info("Script loaded on an unrecognized 16Personalities page.");
        }
    }

    // Start the application
    initializeTracker();
})();