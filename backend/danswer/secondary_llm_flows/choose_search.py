from langchain.schema import BaseMessage
from langchain.schema import HumanMessage
from langchain.schema import SystemMessage

from danswer.chat.chat_utils import combine_message_chain
from danswer.configs.chat_configs import DISABLE_LLM_CHOOSE_SEARCH
from danswer.db.models import ChatMessage
from danswer.llm.factory import get_default_llm
from danswer.llm.interfaces import LLM
from danswer.llm.utils import dict_based_prompt_to_langchain_prompt
from danswer.llm.utils import translate_danswer_msg_to_langchain
from danswer.prompts.chat_prompts import AGGRESSIVE_SEARCH_TEMPLATE
from danswer.prompts.chat_prompts import NO_SEARCH
from danswer.prompts.chat_prompts import REQUIRE_SEARCH_HINT
from danswer.prompts.chat_prompts import REQUIRE_SEARCH_SYSTEM_MSG
from danswer.prompts.chat_prompts import SKIP_SEARCH
from danswer.utils.logger import setup_logger


logger = setup_logger()


def check_if_need_search_multi_message(
    query_message: ChatMessage,
    history: list[ChatMessage],
    llm: LLM,
) -> bool:
    # Always start with a retrieval
    if not history:
        return True

    prompt_msgs: list[BaseMessage] = [SystemMessage(content=REQUIRE_SEARCH_SYSTEM_MSG)]
    prompt_msgs.extend([translate_danswer_msg_to_langchain(msg) for msg in history])

    last_query = query_message.message

    prompt_msgs.append(HumanMessage(content=f"{last_query}\n\n{REQUIRE_SEARCH_HINT}"))

    model_out = llm.invoke(prompt_msgs)

    if (NO_SEARCH.split()[0] + " ").lower() in model_out.lower():
        return False

    return True


def check_if_need_search(
    query_message: ChatMessage,
    history: list[ChatMessage],
    llm: LLM | None = None,
    disable_llm_check: bool = DISABLE_LLM_CHOOSE_SEARCH,
) -> bool:
    def _get_search_messages(
        question: str,
        history_str: str,
    ) -> list[dict[str, str]]:
        messages = [
            {
                "role": "user",
                "content": AGGRESSIVE_SEARCH_TEMPLATE.format(
                    final_query=question, chat_history=history_str
                ).strip(),
            },
        ]

        return messages

    if disable_llm_check:
        return True

    history_str = combine_message_chain(history)

    prompt_msgs = _get_search_messages(
        question=query_message.message, history_str=history_str
    )

    if llm is None:
        llm = get_default_llm()

    filled_llm_prompt = dict_based_prompt_to_langchain_prompt(prompt_msgs)
    require_search_output = llm.invoke(filled_llm_prompt)

    logger.debug(f"Run search prediction: {require_search_output}")

    if (SKIP_SEARCH.split()[0]).lower() in require_search_output.lower():
        return False

    return True
