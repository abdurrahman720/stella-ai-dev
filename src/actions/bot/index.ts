"use server";

import { client } from "@/lib/prisma";
import { extractEmailsFromString, extractURLfromString } from "@/lib/utils";

import { clerkClient } from "@clerk/nextjs";
import { onMailer } from "../mailer";

import Groq from "groq-sdk";
import { onRealTimeChat } from "../conversation";

// const openai = new OpenAi({
//   apiKey: process.env.OPEN_AI_KEY,
// });

// const groq = new OpenAI({
//   apiKey: process.env.AIML_API_KEY,
//   baseURL: "https://api.aimlapi.com/v1",
// });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const onStoreConversations = async (
  id: string,
  message: string,
  role: "assistant" | "user"
) => {
  await client.chatRoom.update({
    where: {
      id,
    },
    data: {
      message: {
        create: {
          message,
          role,
        },
      },
    },
  });
};

export const onGetCurrentChatBot = async (id: string) => {
  try {
    const chatbot = await client.domain.findUnique({
      where: {
        id,
      },
      select: {
        helpdesk: true,
        name: true,
        chatBot: {
          select: {
            id: true,
            welcomeMessage: true,
            icon: true,
            textColor: true,
            background: true,
            helpdesk: true,
          },
        },
      },
    });

    if (chatbot) {
      return chatbot;
    }
  } catch (error) {
    console.log(error);
  }
};

let customerEmail: string | undefined;

export const onAiChatBotAssistant = async (
  id: string,
  chat: { role: "assistant" | "user"; content: string }[],
  author: "user",
  message: string
) => {
  try {
    const chatBotDomain = await client.domain.findUnique({
      where: {
        id,
      },
      select: {
        name: true,
        filterQuestions: {
          where: {
            answered: null,
          },
          select: {
            question: true,
          },
        },
      },
    });
    if (chatBotDomain) {
      const extractedEmail = extractEmailsFromString(message);
      if (extractedEmail) {
        customerEmail = extractedEmail[0];
      }
      console.log(customerEmail);
      if (customerEmail) {
        const checkCustomer = await client.domain.findUnique({
          where: {
            id,
          },
          select: {
            User: {
              select: {
                clerkId: true,
              },
            },
            name: true,
            customer: {
              where: {
                email: {
                  startsWith: customerEmail,
                },
              },
              select: {
                id: true,
                email: true,
                questions: true,
                chatRoom: {
                  select: {
                    id: true,
                    live: true,
                    mailed: true,
                  },
                },
              },
            },
          },
        });
        if (checkCustomer && !checkCustomer.customer.length) {
          const newCustomer = await client.domain.update({
            where: {
              id,
            },
            data: {
              customer: {
                create: {
                  email: customerEmail,
                  questions: {
                    create: chatBotDomain.filterQuestions,
                  },
                  chatRoom: {
                    create: {},
                  },
                },
              },
            },
          });
          if (newCustomer) {
            console.log("new customer made");

            const chatCompletion = await groq.chat.completions.create({
              messages: [
                {
                  role: "assistant",
                  content: `
     Welcome aboard ${customerEmail.split("@")[0]}!
Just say, thanks for your email and go ahead. Nothig else.
      `,
                },
                ...chat,
                {
                  role: "user",
                  content: message,
                },
              ],
              model: "llama3-70b-8192",
            });

            console.log(chatCompletion.choices[0].message);
            if (chatCompletion) {
              const response = {
                role: "assistant",
                content: chatCompletion.choices[0].message.content,
              };

              return { response };
            }
            // const response = {
            //   role: "assistant",
            //   content: `Welcome aboard ${
            //     customerEmail.split("@")[0]
            //   }! I'm glad to connect with you. Now tell me, How can I help?`,
            // };
            // return { response };
          }
        }
        if (checkCustomer && checkCustomer.customer[0].chatRoom[0].live) {
          console.log("sending email");
          const user = await clerkClient.users.getUser(
            checkCustomer.User?.clerkId!
          );
          onMailer(user.emailAddresses[0].emailAddress);
          await onStoreConversations(
            checkCustomer?.customer[0].chatRoom[0].id!,
            message,
            author
          );

          onRealTimeChat(
            checkCustomer.customer[0].chatRoom[0].id,
            message,
            "user",
            author
          );

          if (!checkCustomer.customer[0].chatRoom[0].mailed) {
            const user = await clerkClient.users.getUser(
              checkCustomer.User?.clerkId!
            );

            onMailer(user.emailAddresses[0].emailAddress);

            //update mail status to prevent spamming
            const mailed = await client.chatRoom.update({
              where: {
                id: checkCustomer.customer[0].chatRoom[0].id,
              },
              data: {
                mailed: true,
              },
            });

            if (mailed) {
              return {
                live: true,
                chatRoom: checkCustomer.customer[0].chatRoom[0].id,
              };
            }
          }
          return {
            live: true,
            chatRoom: checkCustomer.customer[0].chatRoom[0].id,
          };
        }

        await onStoreConversations(
          checkCustomer?.customer[0].chatRoom[0].id!,
          message,
          author
        );
        console.log("existing customer");
        console.log([
          chatBotDomain.filterQuestions
            .map((questions) => `${questions.question}`)
            .join(", "),
        ]);

        // const questionKeywords = chatBotDomain.filterQuestions.map(
        //   (questions) => {
        //     return {
        //       originalQuestion: questions.question,
        //       keywords: questions.question
        //         .toLowerCase()
        //         .split(" ") // Split question into individual words
        //         .filter((word) => word.length > 3), // Keep only meaningful words (e.g. length > 3)
        //     };
        //   }
        // );

        // console.log(questionKeywords);

        console.log(checkCustomer?.customer[0].email);

        const chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: "assistant",
              content: `
             You will get an array of questions that you must ask the customer. 
              
              Progress the conversation using those questions. 
              
              Whenever you ask a question from the array i need you to add a keyword at the end of the question '(complete)' this keyword is extremely important. 
              
              Do not forget it.

              only add this keyword when your asking a question from the array of questions. No other question satisfies this condition

              Always maintain character and stay respectfull.

              The array of questions : [${chatBotDomain.filterQuestions
                .map((questions) => questions.question)
                .join(", ")}
        
Once all questions are answered, **transition** the conversation smoothly by asking if they are interested in booking an appointment. Do not offer the link right away.

If the customer agrees to book an appointment, lead them to this link: http://localhost:3000/portal/${id}/appointment/${
                checkCustomer?.customer[0].id
              }.

If the customer makes an inappropriate or off-topic remark or *ask to talk with agent* or does not agree to book an apointment then politely tell them that a real user will take over. I need you to add a keyword '(realtime)' at the end! This is super important.
          `,
            },
            ...chat,
            {
              role: "user",
              content: message,
            },
          ],
          model: "llama3-70b-8192",
        });

        console.log(chatCompletion.choices[0].message);
        console.log(chat[chat.length - 1].content);

        if (chatCompletion.choices[0].message.content?.includes("(realtime)")) {
          console.log("realtime");
          const realtime = await client.chatRoom.update({
            where: {
              id: checkCustomer?.customer[0].chatRoom[0].id,
            },
            data: {
              live: true,
            },
          });

          if (realtime) {
            const response = {
              role: "assistant",
              content: chatCompletion.choices[0].message.content.replace(
                "(realtime)",
                ""
              ),
            };

            await onStoreConversations(
              checkCustomer?.customer[0].chatRoom[0].id!,
              response.content,
              "assistant"
            );

            return { response };
          }
        }

        if (chat[chat.length - 1].content.includes("(complete)")) {
          console.log(message);
          const firstUnansweredQuestion =
            await client.customerResponses.findFirst({
              where: {
                customerId: checkCustomer?.customer[0].id,
                answered: null,
              },
              select: {
                id: true,
              },
              orderBy: {
                question: "asc",
              },
            });
          // console.log(firstUnansweredQuestion.);
          if (firstUnansweredQuestion) {
            await client.customerResponses.update({
              where: {
                id: firstUnansweredQuestion.id,
              },
              data: {
                answered: message,
              },
            });
          }
        }

        if (chatCompletion) {
          const generatedLink = extractURLfromString(
            chatCompletion.choices[0].message.content as string
          );

          console.log(generatedLink);

          if (generatedLink) {
            const link = generatedLink[0].replace(".", "").replace("]", "");

            const response = {
              role: "assistant",
              content: `I'd be happy to help you book an appointment. Before we do that, I just need to provide you with a link to our appointment booking page. This link is specific to your customer profile, and it will allow you to schedule an appointment at a time that suits you best. ${link}`,
              // link: link,
            };

            await onStoreConversations(
              checkCustomer?.customer[0].chatRoom[0].id!,
              `${response.content} `,
              "assistant"
            );

            return { response };
          }

          const response = {
            role: "assistant",
            content: chatCompletion.choices[0].message.content,
          };

          await onStoreConversations(
            checkCustomer?.customer[0].chatRoom[0].id!,
            `${response.content}`,
            "assistant"
          );

          return { response };
        }
      }
      console.log("No customer");
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          {
            role: "assistant",
            content: `
      You (Alex) are a highly knowledgeable and experienced sales representative for Leavoda, an all-in-one Field Service Management software. Leavoda helps businesses schedule jobs, dispatch teams, invoice clients, track performance, and get paid — all in one place. 

      Start by warmly welcoming the customer on behalf of Leavoda, making them feel comfortable and must ask for their email so that the progress can be saved It is most important. Remember the email is not for follow up!
      
      Do not continue conversations until you ask and get the email. Remember it.
    
      Be respectful and maintain a professional tone while never breaking character and do not forget to ask email.

    If the customer makes an inappropriate or off-topic remark or *ask to talk with agent* or does not agree to book an apointment then politely tell them that a real user will take over. I need you to add a keyword '(realtime)' at the end! This is super important.
      `,
          },
          ...chat,
          {
            role: "user",
            content: message,
          },
        ],
        model: "llama3-70b-8192",
      });

      console.log(chatCompletion.choices[0].message);
      if (chatCompletion) {
        const extractedEmail = extractEmailsFromString(
          chatCompletion.choices[0].message.content as string
        );
        console.log(extractedEmail);
        if (extractedEmail) {
          customerEmail = extractedEmail[0];
          console.log(customerEmail);
          const response = {
            role: "assistant",
            content: `Welcome abroad! Thanks for providing your email! `,
          };

          return { response };
        } else {
          const response = {
            role: "assistant",
            content: chatCompletion.choices[0].message.content,
          };

          return { response };
        }
      }
    }
  } catch (error) {
    console.log(error);
  }
};
