/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   orders-validation.service.ts                       :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: mbah <mbah@student.42lyon.fr>              +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2025/03/28 23:31:45 by mbah              #+#    #+#             */
/*   Updated: 2025/04/11 01:56:05 by mbah             ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { TransactionService } from "./transaction.service";
import { PrismaService } from "src/prisma/prisma.service";
import { Order, OrderItemStatus, OrderStatus } from "@prisma/client";
import { SendEmailService } from "src/send-email/send-email.service";
import { buyerOrderUpdateTemplate } from "src/send-email/template/buyer-order-updated";
import { OrderItem } from "src/interfaces/order";
import { TransactionUtils } from "./transaction-utils.service";
import { InvoiceService } from "src/invoice/invoice.service";
import { REFUSED } from "dns";

@Injectable()
export class OrdersValidationService {
	constructor(
		private readonly transactionUtils: TransactionUtils,
		private readonly prismaService: PrismaService,
		private readonly sendEmailService: SendEmailService,
		private readonly invoiceService: InvoiceService
	) {}

	private async check_if_item_an_order_exist(
		productId: string,
		sellerId: string,
		orderId: string,
	  )
	{
		const order = await this.prismaService.order.findUnique({
			where: { id: orderId },
			include: { items: true },
		  });
		  
		if (!order)
			throw new HttpException('Commande non trouvée', HttpStatus.NOT_FOUND);
		  
		 const orderItem = order.items.find(item => item.productId === productId && item.sellerId === sellerId);
		  if (!orderItem)
			throw new HttpException('Produit non trouvé dans cette commande pour ce vendeur', HttpStatus.BAD_REQUEST);
		return (order);
	}
	
	// Fonction pour confirmer les produits par le vendeur
	public async seller_confirm_product_by_id(
		productId: string,
		sellerId: string,
		orderId: string,
		decision: OrderItemStatus
	  )
	{
		const order = await this.check_if_item_an_order_exist(productId, sellerId, orderId);
		
		const updatedOrderItem = await this.prismaService.orderItem.update({
		  where: {  orderId, productId, sellerId  },
		  data: { status: decision },
		});
	
		if (!updatedOrderItem)
		  throw new HttpException('Impossible de mettre à jour le statut de l\'item', HttpStatus.BAD_REQUEST);
	
		const order_update = await this.check_if_item_an_order_exist(productId, sellerId, orderId);
		const allItemsConfirmed = order_update.items.every(item => item.status === 'CONFIRMED');
	    const allItemsAnswered = order_update.items.every(item => item.status !== 'PENDING');
		const allItemsRefused = order_update.items.every(item => item.status === 'REFUSED');
	
		if (allItemsAnswered) {
			let newOrderStatus;
			
			if (allItemsConfirmed) {
				newOrderStatus = OrderStatus.CONFIRMED;
			} else if (allItemsRefused) {
				newOrderStatus = OrderStatus.CANCELED;
			} else {
				newOrderStatus = OrderStatus.PARTIAL;
			}
	
			await this.prismaService.order.update({
				where: { id: orderId },
				data: { status: newOrderStatus },
			});
	
			if (!allItemsRefused) {
				await this.invoiceService.generateInvoice(order.id);
			}
	
			await this.notify_user_second_confirmation_reminder(order.id);
		} else {
			console.log(`Il y a encore des produits en attente de confirmation par les vendeurs. Nombre de produits en attente : ${order_update.items.filter(item => item.status === 'PENDING').length}`);
		}
		return ({ message: 'Merci pour votre réponse. Le produit a été mis à jour avec succès.' });
	}

	private async get_order_and_buyerInfo(orderId: string) {
		const order = await this.prismaService.order.findUnique({
			where: { id: orderId },
			include: { items: { include: { product: true, seller: true } } },
		  });
		
		  if (!order) throw new HttpException('Commande non trouvée', HttpStatus.NOT_FOUND);
		
		  const buyerInfo = await this.prismaService.user.findUnique({
			where: { id: order.buyerId },
			select: { name: true, email: true },
		  });
		
		  if (!buyerInfo) throw new HttpException('Acheteur non trouvé', HttpStatus.NOT_FOUND);
		  return ({ order, buyerInfo })
	}

	private async get_confirmed_and_rejected_products(order: Order | any) {
		const confirmedProducts: OrderItem[] = [];
		const rejectedProducts: OrderItem[] = [];
		let refundAmount = 0;
	  
		order.items.forEach(item => {
		  if (item.status === 'CONFIRMED') {
			confirmedProducts.push(item);
		  } else if (item.status === 'REFUSED') {
			rejectedProducts.push(item);
			refundAmount += item.price * item.quantity;
		  }
		});
		return ({ confirmedProducts, rejectedProducts, refundAmount })
	}
	
	private async notify_user_second_confirmation_reminder(orderId: string) {
		const { order, buyerInfo } = await this.get_order_and_buyerInfo(orderId);
	  
		const { 
			confirmedProducts,
			rejectedProducts,
			refundAmount } = await this.get_confirmed_and_rejected_products(order);
		
		for (const item of rejectedProducts) {
			await this.transactionUtils.update_product_stock(item.product, this.prismaService, item.quantity, '+');
		}
		await this.sendEmailService.send_email(
			0,
			buyerInfo.email,
			'Mise à jour de votre commande',
			buyerOrderUpdateTemplate,
			buyerInfo.name,
			orderId,
			order.createdAt.toISOString(),
			confirmedProducts.map((item) => ({
			  name: item.product.name,
			  quantity: item.quantity,
			  price: item.price,
			})),
			rejectedProducts.map((item) => ({
			  name: item.product.name,
			  quantity: item.quantity,
			  price: item.price,
			})),
			refundAmount
		);
		  
		console.log("Second email de mise à jour envoyé à l'acheteur.");
	}
			
}