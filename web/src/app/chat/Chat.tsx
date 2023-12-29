"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { FiRefreshCcw, FiSend, FiStopCircle } from "react-icons/fi";
import { AIMessage, HumanMessage } from "./message/Messages";
import { AnswerPiecePacket, DanswerDocument } from "@/lib/search/interfaces";
import {
  BackendChatSession,
  BackendMessage,
  DocumentsResponse,
  Message,
  RetrievalType,
  StreamingError,
} from "./interfaces";
import { useRouter } from "next/navigation";
import { FeedbackType } from "./types";
import {
  createChatSession,
  getCitedDocumentsFromMessage,
  getHumanAndAIMessageFromMessageNumber,
  getLastSuccessfulMessageId,
  handleAutoScroll,
  handleChatFeedback,
  nameChatSession,
  processRawChatHistory,
  sendMessage,
} from "./lib";
import { ThreeDots } from "react-loader-spinner";
import { FeedbackModal } from "./modal/FeedbackModal";
import { DocumentSidebar } from "./documentSidebar/DocumentSidebar";
import { Persona } from "../admin/personas/interfaces";
import { ChatPersonaSelector } from "./ChatPersonaSelector";
import { useFilters } from "@/lib/hooks";
import { DocumentSet, ValidSources } from "@/lib/types";
import { ChatFilters } from "./modifiers/ChatFilters";
import { buildFilters } from "@/lib/search/utils";
import { SelectedDocuments } from "./modifiers/SelectedDocuments";
import { usePopup } from "@/components/admin/connectors/Popup";
import { ResizableSection } from "@/components/resizable/ResizableSection";
import { DanswerInitializingLoader } from "@/components/DanswerInitializingLoader";

const MAX_INPUT_HEIGHT = 200;

export const Chat = ({
  existingChatSessionId,
  existingChatSessionPersonaId,
  availableSources,
  availableDocumentSets,
  availablePersonas,
  documentSidebarInitialWidth,
  shouldhideBeforeScroll,
}: {
  existingChatSessionId: number | null;
  existingChatSessionPersonaId: number | undefined;
  availableSources: ValidSources[];
  availableDocumentSets: DocumentSet[];
  availablePersonas: Persona[];
  documentSidebarInitialWidth?: number;
  shouldhideBeforeScroll?: boolean;
}) => {
  const router = useRouter();
  const { popup, setPopup } = usePopup();

  // fetch messages for the chat session
  const [isFetchingChatMessages, setIsFetchingChatMessages] = useState(
    existingChatSessionId !== null
  );

  // this is triggered every time the user switches which chat
  // session they are using
  useEffect(() => {
    textareaRef.current?.focus();
    setChatSessionId(existingChatSessionId);

    async function initialSessionFetch() {
      if (existingChatSessionId === null) {
        setIsFetchingChatMessages(false);
        setMessageHistory([]);
        return;
      }

      setIsFetchingChatMessages(true);
      const response = await fetch(
        `/api/chat/get-chat-session/${existingChatSessionId}`
      );
      const chatSession = (await response.json()) as BackendChatSession;
      const newMessageHistory = processRawChatHistory(chatSession.messages);
      setMessageHistory(newMessageHistory);

      const latestMessageId =
        newMessageHistory[newMessageHistory.length - 1]?.messageId;
      setSelectedMessageForDocDisplay(
        latestMessageId !== undefined ? latestMessageId : null
      );

      setIsFetchingChatMessages(false);
    }

    initialSessionFetch();
  }, [existingChatSessionId]);

  const [chatSessionId, setChatSessionId] = useState<number | null>(
    existingChatSessionId
  );
  const [message, setMessage] = useState("");
  const [messageHistory, setMessageHistory] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  // for document display
  // NOTE: -1 is a special designation that means the latest AI message
  const [selectedMessageForDocDisplay, setSelectedMessageForDocDisplay] =
    useState<number | null>(null);
  const { aiMessage } = selectedMessageForDocDisplay
    ? getHumanAndAIMessageFromMessageNumber(
        messageHistory,
        selectedMessageForDocDisplay
      )
    : { aiMessage: null };
  const [selectedDocuments, setSelectedDocuments] = useState<DanswerDocument[]>(
    []
  );

  const [selectedPersona, setSelectedPersona] = useState<Persona | undefined>(
    existingChatSessionPersonaId !== undefined
      ? availablePersonas.find(
          (persona) => persona.id === existingChatSessionPersonaId
        )
      : availablePersonas[0]
  );

  const filterManager = useFilters();

  // state for cancelling streaming
  const [isCancelled, setIsCancelled] = useState(false);
  const isCancelledRef = useRef(isCancelled);
  useEffect(() => {
    isCancelledRef.current = isCancelled;
  }, [isCancelled]);

  const [currentFeedback, setCurrentFeedback] = useState<
    [FeedbackType, number] | null
  >(null);

  // auto scroll as message comes out
  const scrollableDivRef = useRef<HTMLDivElement>(null);
  const endDivRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isStreaming || !message) {
      handleAutoScroll(endDivRef, scrollableDivRef);
    }
  });

  // scroll to bottom initially
  const [hasPerformedInitialScroll, setHasPerformedInitialScroll] = useState(
    shouldhideBeforeScroll !== true
  );
  useEffect(() => {
    endDivRef.current?.scrollIntoView();
    setHasPerformedInitialScroll(true);
  }, [isFetchingChatMessages]);

  // handle re-sizing of the text area
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "0px";
      textarea.style.height = `${Math.min(
        textarea.scrollHeight,
        MAX_INPUT_HEIGHT
      )}px`;
    }
  }, [message]);

  // used for resizing of the document sidebar
  const masterFlexboxRef = useRef<HTMLDivElement>(null);
  const [maxDocumentSidebarWidth, setMaxDocumentSidebarWidth] = useState<
    number | null
  >(null);
  const adjustDocumentSidebarWidth = () => {
    if (masterFlexboxRef.current && document.documentElement.clientWidth) {
      // numbers below are based on the actual width the center section for different
      // screen sizes. `1700` corresponds to the custom "3xl" tailwind breakpoint
      // NOTE: some buffer is needed to account for scroll bars
      if (document.documentElement.clientWidth > 1700) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 950);
      } else if (document.documentElement.clientWidth > 1420) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 760);
      } else {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 660);
      }
    }
  };
  useEffect(() => {
    adjustDocumentSidebarWidth(); // Adjust the width on initial render
    window.addEventListener("resize", adjustDocumentSidebarWidth); // Add resize event listener

    return () => {
      window.removeEventListener("resize", adjustDocumentSidebarWidth); // Cleanup the event listener
    };
  }, []);

  if (!documentSidebarInitialWidth && maxDocumentSidebarWidth) {
    documentSidebarInitialWidth = Math.min(700, maxDocumentSidebarWidth);
  }

  const onSubmit = async (messageOverride?: string) => {
    let currChatSessionId: number;
    let isNewSession = chatSessionId === null;
    if (isNewSession) {
      currChatSessionId = await createChatSession(selectedPersona?.id || 0);
    } else {
      currChatSessionId = chatSessionId as number;
    }
    setChatSessionId(currChatSessionId);

    const currMessage = messageOverride || message;
    const currMessageHistory = messageHistory;
    setMessageHistory([
      ...currMessageHistory,
      {
        messageId: 0,
        message: currMessage,
        type: "user",
      },
    ]);
    setMessage("");

    setIsStreaming(true);
    let answer = "";
    let query: string | null = null;
    let retrievalType: RetrievalType =
      selectedDocuments.length > 0
        ? RetrievalType.SelectedDocs
        : RetrievalType.None;
    let documents: DanswerDocument[] = selectedDocuments;
    let error: string | null = null;
    let finalMessage: BackendMessage | null = null;
    try {
      const lastSuccessfulMessageId =
        getLastSuccessfulMessageId(currMessageHistory);
      for await (const packetBunch of sendMessage({
        message: currMessage,
        parentMessageId: lastSuccessfulMessageId,
        chatSessionId: currChatSessionId,
        promptId: 0,
        filters: buildFilters(
          filterManager.selectedSources,
          filterManager.selectedDocumentSets,
          filterManager.timeRange
        ),
        selectedDocumentIds: selectedDocuments
          .filter(
            (document) =>
              document.db_doc_id !== undefined && document.db_doc_id !== null
          )
          .map((document) => document.db_doc_id as number),
      })) {
        for (const packet of packetBunch) {
          if (Object.hasOwn(packet, "answer_piece")) {
            answer += (packet as AnswerPiecePacket).answer_piece;
          } else if (Object.hasOwn(packet, "top_documents")) {
            documents = (packet as DocumentsResponse).top_documents;
            query = (packet as DocumentsResponse).rephrased_query;
            retrievalType = RetrievalType.Search;
            if (documents && documents.length > 0) {
              // point to the latest message (we don't know the messageId yet, which is why
              // we have to use -1)
              setSelectedMessageForDocDisplay(-1);
            }
          } else if (Object.hasOwn(packet, "error")) {
            error = (packet as StreamingError).error;
          } else if (Object.hasOwn(packet, "message_id")) {
            finalMessage = packet as BackendMessage;
          }
        }
        setMessageHistory([
          ...currMessageHistory,
          {
            messageId: finalMessage?.parent_message || null,
            message: currMessage,
            type: "user",
          },
          {
            messageId: finalMessage?.message_id || null,
            message: error || answer,
            type: error ? "error" : "assistant",
            retrievalType,
            query: finalMessage?.rephrased_query || query,
            documents: finalMessage?.context_docs?.top_documents || documents,
            citations: finalMessage?.citations || {},
          },
        ]);
        if (isCancelledRef.current) {
          setIsCancelled(false);
          break;
        }
      }
    } catch (e: any) {
      const errorMsg = e.message;
      setMessageHistory([
        ...currMessageHistory,
        {
          messageId: null,
          message: currMessage,
          type: "user",
        },
        {
          messageId: null,
          message: errorMsg,
          type: "error",
        },
      ]);
    }
    setIsStreaming(false);
    if (isNewSession) {
      if (finalMessage) {
        setSelectedMessageForDocDisplay(finalMessage.message_id);
      }
      await nameChatSession(currChatSessionId, currMessage);
      router.push(`/chat?chatId=${currChatSessionId}`, {
        scroll: false,
      });
    }
    if (
      finalMessage?.context_docs &&
      finalMessage.context_docs.top_documents.length > 0 &&
      retrievalType === RetrievalType.Search
    ) {
      setSelectedMessageForDocDisplay(finalMessage.message_id);
    }
  };

  const onFeedback = async (
    messageId: number,
    feedbackType: FeedbackType,
    feedbackDetails: string
  ) => {
    if (chatSessionId === null) {
      return;
    }

    const response = await handleChatFeedback(
      messageId,
      feedbackType,
      feedbackDetails
    );

    if (response.ok) {
      setPopup({
        message: "Thanks for your feedback!",
        type: "success",
      });
    } else {
      const responseJson = await response.json();
      const errorMsg = responseJson.detail || responseJson.message;
      setPopup({
        message: `Failed to submit feedback - ${errorMsg}`,
        type: "error",
      });
    }
  };

  return (
    <div className="flex w-full overflow-x-hidden" ref={masterFlexboxRef}>
      {popup}
      {currentFeedback && (
        <FeedbackModal
          feedbackType={currentFeedback[0]}
          onClose={() => setCurrentFeedback(null)}
          onSubmit={(feedbackDetails) => {
            onFeedback(currentFeedback[1], currentFeedback[0], feedbackDetails);
            setCurrentFeedback(null);
          }}
        />
      )}

      {documentSidebarInitialWidth !== undefined ? (
        <>
          <div className="w-full sm:relative">
            <div
              className="w-full h-screen flex flex-col overflow-y-auto relative"
              ref={scrollableDivRef}
            >
              {selectedPersona && (
                <div className="sticky top-0 left-80 z-10 w-full bg-background/90">
                  <div className="ml-2 p-1 rounded mt-2 w-fit">
                    <ChatPersonaSelector
                      personas={availablePersonas}
                      selectedPersonaId={selectedPersona?.id}
                      onPersonaChange={(persona) => {
                        if (persona) {
                          setSelectedPersona(persona);
                        }
                      }}
                    />
                  </div>
                </div>
              )}

              {messageHistory.length === 0 &&
                !isFetchingChatMessages &&
                !isStreaming && (
                  <div className="flex justify-center items-center h-full">
                    <div className="px-8 w-searchbar-xs 2xl:w-searchbar-sm 3xl:w-searchbar">
                      <div className="flex">
                        <div className="mx-auto h-[80px] w-[80px]">
                          <Image
                            src="/logo.png"
                            alt="Logo"
                            width="1419"
                            height="1520"
                          />
                        </div>
                      </div>
                      <div className="mx-auto text-2xl font-bold text-strong p-4 w-fit">
                        What are you looking for today?
                      </div>
                    </div>
                  </div>
                )}

              <div
                className={
                  "mt-4 pt-12 sm:pt-0 mx-8" +
                  (hasPerformedInitialScroll ? "" : " invisible")
                }
              >
                {messageHistory.map((message, i) => {
                  if (message.type === "user") {
                    return (
                      <div key={i}>
                        <HumanMessage content={message.message} />
                      </div>
                    );
                  } else if (message.type === "assistant") {
                    const isShowingRetrieved =
                      (selectedMessageForDocDisplay !== null &&
                        selectedMessageForDocDisplay === message.messageId) ||
                      (selectedMessageForDocDisplay === -1 &&
                        i === messageHistory.length - 1);
                    return (
                      <div key={i}>
                        <AIMessage
                          messageId={message.messageId}
                          content={message.message}
                          query={messageHistory[i]?.query || undefined}
                          citedDocuments={getCitedDocumentsFromMessage(message)}
                          isComplete={
                            i !== messageHistory.length - 1 || !isStreaming
                          }
                          hasDocs={
                            (message.documents &&
                              message.documents.length > 0) === true
                          }
                          handleFeedback={
                            i === messageHistory.length - 1 && isStreaming
                              ? undefined
                              : (feedbackType) =>
                                  setCurrentFeedback([
                                    feedbackType,
                                    message.messageId as number,
                                  ])
                          }
                          isCurrentlyShowingRetrieved={isShowingRetrieved}
                          handleShowRetrieved={(messageNumber) => {
                            if (isShowingRetrieved) {
                              setSelectedMessageForDocDisplay(null);
                            } else {
                              if (messageNumber !== null) {
                                setSelectedMessageForDocDisplay(messageNumber);
                              } else {
                                setSelectedMessageForDocDisplay(-1);
                              }
                            }
                          }}
                        />
                      </div>
                    );
                  } else {
                    return (
                      <div key={i}>
                        <AIMessage
                          messageId={message.messageId}
                          content={
                            <p className="text-red-700 text-sm my-auto">
                              {message.message}
                            </p>
                          }
                        />
                      </div>
                    );
                  }
                })}

                {isStreaming &&
                  messageHistory.length &&
                  messageHistory[messageHistory.length - 1].type === "user" && (
                    <div key={messageHistory.length}>
                      <AIMessage
                        messageId={null}
                        content={
                          <div className="text-sm my-auto">
                            <ThreeDots
                              height="30"
                              width="50"
                              color="#3b82f6"
                              ariaLabel="grid-loading"
                              radius="12.5"
                              wrapperStyle={{}}
                              wrapperClass=""
                              visible={true}
                            />
                          </div>
                        }
                      />
                    </div>
                  )}

                {/* Some padding at the bottom so the search bar has space at the bottom to not cover the last message*/}
                <div className={`min-h-[200px] w-full`}></div>

                <div ref={endDivRef} />
              </div>
            </div>

            <div className="absolute bottom-0 z-10 w-full bg-background border-t border-border">
              <div className="w-full pb-4 pt-2">
                {/* {(isStreaming || messageHistory.length > 0) && (
              <div className="flex justify-center w-full">
                <div className="w-[800px] flex">
                  <div className="cursor-pointer flex w-fit p-2 rounded border border-neutral-400 text-sm hover:bg-neutral-200 ml-auto mr-4">
                    {isStreaming ? (
                      <div
                        onClick={() => setIsCancelled(true)}
                        className="flex"
                      >
                        <FiStopCircle className="my-auto mr-1" />
                        <div>Stop Generating</div>
                      </div>
                    ) : (
                      <div
                        className="flex"
                        onClick={() => {
                          if (chatSessionId) {
                            handleRegenerate(chatSessionId);
                          }
                        }}
                      >
                        <FiRefreshCcw className="my-auto mr-1" />
                        <div>Regenerate</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )} */}

                <div className="flex">
                  <div className="w-searchbar-xs 2xl:w-searchbar-sm 3xl:w-searchbar mx-auto px-4 pt-1 flex">
                    {selectedDocuments.length > 0 ? (
                      <SelectedDocuments
                        selectedDocuments={selectedDocuments}
                      />
                    ) : (
                      <ChatFilters
                        {...filterManager}
                        existingSources={availableSources}
                        availableDocumentSets={availableDocumentSets}
                      />
                    )}
                  </div>
                </div>

                <div className="flex justify-center py-2 max-w-screen-lg mx-auto mb-2">
                  <div className="w-full shrink relative px-4 w-searchbar-xs 2xl:w-searchbar-sm 3xl:w-searchbar mx-auto">
                    <textarea
                      ref={textareaRef}
                      autoFocus
                      className={`
                    opacity-100
                    w-full
                    shrink
                    border 
                    border-border 
                    rounded-lg 
                    outline-none 
                    placeholder-gray-400 
                    pl-4
                    pr-12 
                    py-4 
                    overflow-hidden
                    h-14
                    ${
                      (textareaRef?.current?.scrollHeight || 0) >
                      MAX_INPUT_HEIGHT
                        ? "overflow-y-auto"
                        : ""
                    } 
                    whitespace-normal 
                    break-word
                    overscroll-contain
                    resize-none
                    `}
                      style={{ scrollbarWidth: "thin" }}
                      role="textarea"
                      aria-multiline
                      placeholder="Ask me anything..."
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          message
                        ) {
                          onSubmit();
                          event.preventDefault();
                        }
                      }}
                      suppressContentEditableWarning={true}
                    />
                    <div className="absolute bottom-4 right-10">
                      <div
                        className={"cursor-pointer"}
                        onClick={() => {
                          if (!isStreaming) {
                            if (message) {
                              onSubmit();
                            }
                          } else {
                            setIsCancelled(true);
                          }
                        }}
                      >
                        {isStreaming ? (
                          <FiStopCircle
                            size={18}
                            className={
                              "text-emphasis w-9 h-9 p-2 rounded-lg hover:bg-hover"
                            }
                          />
                        ) : (
                          <FiSend
                            size={18}
                            className={
                              "text-emphasis w-9 h-9 p-2 rounded-lg " +
                              (message ? "bg-blue-200" : "")
                            }
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <ResizableSection
            intialWidth={documentSidebarInitialWidth}
            minWidth={400}
            maxWidth={maxDocumentSidebarWidth || undefined}
          >
            <DocumentSidebar
              selectedMessage={aiMessage}
              selectedDocuments={selectedDocuments}
              setSelectedDocuments={setSelectedDocuments}
              isLoading={isFetchingChatMessages}
            />
          </ResizableSection>
        </>
      ) : (
        <div className="mx-auto h-full flex flex-col">
          <div className="my-auto">
            <DanswerInitializingLoader />
          </div>
        </div>
      )}
    </div>
  );
};
